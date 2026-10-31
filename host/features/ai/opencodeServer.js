// Manages long-lived OpenCode HTTP server process for rewind and file snapshot APIs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import spawn from "cross-spawn"; // Windows: npm-installed opencode is a .cmd shim a bare spawn cannot exec
import { createLogger } from "../../lib/logger.js";
import { PATHS } from "../../lib/constants.js";
import { OPENCODE_SERVER_PORT, OPENCODE_PROMPT_TIMEOUT_MS } from "./constants.js";
import { getExtendedEnv } from "./adapters/env.js";
import { promptInput, messageRecord, questionRecord, formAnswer } from "./opencodeV2.js";

const logger = createLogger("ai");
const BOOT_TIMEOUT_MS = 15000;
const PORT_POLL_MS = 250;
const execFileAsync = promisify(execFile);
const PROCESS_QUERY_TIMEOUT_MS = 5000;
// The command route blocks until the whole agent loop ends — the generic 30s
// api timeout would abort live command turns mid-stream.
const COMMAND_TIMEOUT_MS = 600000;
const MESSAGE_PAGE_SIZE = 100;

const v2Sessions = new Set();
const pendingForms = new Map();

let proc = null;
let base = null;
let booting = null;
let password = null;
let modernApi = false;
// PID of an adopted server a previous 9remote agent spawned (marker file match):
// retirable when idle, unlike one the user started by hand.
let adoptedOurs = null;

// Under NREMOTE_HOME, not os.tmpdir(): the OS purges temp files after a few days,
// and a marker that vanished while its server lived on turned it into an orphan
// nobody could adopt — 400MB held forever.
const markerFile = () => path.join(PATHS.STATE, `opencode-serve-${OPENCODE_SERVER_PORT}.pid`);
const passwordFile = () => path.join(PATHS.STATE, `opencode-serve-${OPENCODE_SERVER_PORT}.password`);
function serverPassword() {
  if (password) return password;
  password = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || null;
  if (password) return password;
  fs.mkdirSync(PATHS.STATE, { recursive: true });
  try { password = fs.readFileSync(passwordFile(), "utf8").trim(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (password) return password;
  const generated = randomBytes(32).toString("base64url");
  try { fs.writeFileSync(passwordFile(), generated, { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  password = fs.readFileSync(passwordFile(), "utf8").trim();
  return password;
}

function authHeaders(headers = {}) {
  return password ? { ...headers, Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : headers;
}

export async function fetchServer(route, options = {}) {
  const url = await ensureServer();
  return fetch(`${url}${route}`, { ...options, headers: authHeaders(options.headers) });
}
const clearMarker = () => { try { fs.unlinkSync(markerFile()); } catch {} };
const markerMatches = async (pid) => {
  if (!pid) return false;
  try { return String(fs.readFileSync(markerFile(), "utf8")).trim() === String(pid); } catch { return false; }
};

function opencodeDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "opencode");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode");
}

function readOpencodeAuth() {
  try {
    const authPath = path.join(opencodeDataDir(), "auth.json");
    if (!fs.existsSync(authPath)) return null;
    return JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
}

function buildOpencodeEnv() {
  const env = getExtendedEnv();
  const auth = readOpencodeAuth();
  if (auth && typeof auth === "object") {
    if (auth["opencode-go"]?.key && !env.OPENCODE_API_KEY) {
      env.OPENCODE_API_KEY = auth["opencode-go"].key;
    }
  }
  return env;
}

// Sync API keys from auth.json to v2 server integrations so models become available.
async function syncCredentials(url) {
  const auth = readOpencodeAuth();
  if (!auth || typeof auth !== "object") return;
  for (const [id, entry] of Object.entries(auth)) {
    if (entry?.type === "api" && entry.key) {
      try {
        await fetch(`${url}/api/integration/${id}/connect/key`, {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ key: entry.key }),
          signal: AbortSignal.timeout(3000)
        });
      } catch (e) {
        logger.warn(`[opencode] failed to sync credential for ${id}: ${e.message}`);
      }
    }
  }
}

async function waitForPort(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/session`, { headers: authHeaders(), signal: AbortSignal.timeout(2000) });
      // Another HTTP process on the port answers HTML — not our server.
      if (res.ok && (res.headers.get("content-type") || "").includes("application/json")) {
        const info = await fetch(`${url}/api/info`, { headers: authHeaders(), signal: AbortSignal.timeout(2000) });
        modernApi = false;
        if (info.ok && (info.headers.get("content-type") || "").includes("application/json")) {
          const identity = await info.json();
          modernApi = Number(String(identity.version || "").split(".")[0]) >= 2;
        }
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, PORT_POLL_MS));
  }
  return false;
}

// Query the listener PID using the platform's process tools.
async function portHolder(port) {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { timeout: PROCESS_QUERY_TIMEOUT_MS, windowsHide: true });
      return /^\d+$/.test(stdout.trim()) ? stdout.trim() : null;
    }
    const out = await new Promise((resolve) =>
      execFile("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { timeout: 3000 }, (e, stdout) => resolve(e ? "" : stdout)));
    return out.split("\n").map((s) => s.trim()).filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

// Verify PID is OUR opencode serve — this guards a kill, so the port must match too:
// a `serve` on another port is the user's own, and it only shares the binary name.
async function isOurServer(pid) {
  if (!/^\d+$/.test(String(pid))) return false;
  try {
    const { stdout } = process.platform === "win32"
      ? await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { timeout: PROCESS_QUERY_TIMEOUT_MS, windowsHide: true })
      : await execFileAsync("ps", ["-o", "command=", "-p", String(pid)], { timeout: PROCESS_QUERY_TIMEOUT_MS });
    const args = (stdout.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((arg) => arg.replace(/^["']|["']$/g, ""));
    const serve = args.indexOf("serve");
    return serve > 0 && /^opencode(?:\.exe|\.cmd|\.js)?$/i.test(path.basename(args[serve - 1]))
      && args[args.indexOf("--port") + 1] === String(OPENCODE_SERVER_PORT)
      && args[args.indexOf("--hostname") + 1] === "127.0.0.1";
  } catch {
    return false;
  }
}

async function terminateServer(target) {
  if (!target) return;
  if (process.platform === "win32" && target.pid && target.kill) {
    await execFileAsync("taskkill.exe", ["/PID", String(target.pid), "/T", "/F"], { timeout: PROCESS_QUERY_TIMEOUT_MS, windowsHide: true });
    return;
  }
  if (target.kill) target.kill("SIGTERM");
  else process.kill(Number(target.pid), "SIGTERM");
}

// Ensure OpenCode server is running and return its base URL.
export async function ensureServer() {
  if (base && proc && proc.exitCode === null) return base;
  if (base && adoptedOurs) {
    try { process.kill(adoptedOurs, 0); return base; }
    catch { base = null; adoptedOurs = null; }
  }
  if (booting) return booting;

  booting = (async () => {
    const port = serverPort();
    const url = `http://127.0.0.1:${port}`;
    serverPassword();

    // Adopt running server if already answering on port.
    if (await waitForPort(url, Date.now() + 1000)) {
      base = url;
      // A leftover from an earlier 9remote agent is still ours to retire. The argv
      // check is the durable half: a purged/missing marker (OS temp cleanup, a
      // marker lost across agent runs) must not turn our own server into a
      // permanent orphan — isOurServer only matches our exact serve invocation.
      const holder = await portHolder(port);
      if ((await markerMatches(holder)) || (await isOurServer(holder))) {
        adoptedOurs = Number(holder);
        try { fs.writeFileSync(markerFile(), String(holder)); } catch {}
        // No session retained it in THIS run — without arming here an adopted
        // leftover outlives the agent forever (nobody opens a chat to release it).
        armIdleStop();
      }
      syncCredentials(url).catch(() => {});
      return url;
    }

    const incumbent = await portHolder(port);
    if (incumbent) {
      if (!(await isOurServer(incumbent))) throw new Error(`OpenCode port ${port} is occupied by another process`);
      logger.warn(`[opencode] replacing inaccessible managed server pid ${incumbent} on port ${port}`);
      await terminateServer({ pid: Number(incumbent) });
      await new Promise((resolve) => setTimeout(resolve, PORT_POLL_MS));
    }

    // Terminate unresponsive OpenCode server holding the port.
    let lastFail = "";
    let stderrTail = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      lastFail = "";
      stderrTail = "";
      proc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
        env: { ...buildOpencodeEnv(), OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      const child = proc;
      proc.stdout.on("data", () => {});
      // Drain stderr to prevent pipe buffer from filling — but keep a tail, because
      // "did not start" alone never says why (bad flag, old version, auth error).
      proc.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-2048); });
      proc.on("error", (e) => {
        lastFail = e.message;
        logger.warn(`[opencode] server failed to start: ${e.message}`);
        if (proc === child) { proc = null; base = null; }
      });
      proc.on("exit", (code) => {
        // A real exit during boot is a failure we can name; our own kill (signal, no code) is not.
        if (code != null) lastFail = `exited with code ${code}${stderrTail ? `: ${stderrTail.replace(/\s+/g, " ").trim().slice(0, 300)}` : ""}`;
        if (proc === child) { proc = null; base = null; clearMarker(); }
      });

      if (await waitForPort(url, Date.now() + BOOT_TIMEOUT_MS)) {
        base = url;
        // Ownership marker: a later agent adopts this server knowing it is ours.
        const holder = await portHolder(port);
        try { fs.writeFileSync(markerFile(), String(holder || child.pid)); } catch {}
        // A caller with no chat session (e.g. the model catalog) must not leave
        // the spawn alive forever; armIdleStop no-ops when a session retained it.
        armIdleStop();
        syncCredentials(url).catch(() => {});
        return url;
      }
      try { await terminateServer(child); } catch (error) { logger.debug(`[opencode] stop after failed boot: ${error.message}`); }
      proc = null;

      const holder = await portHolder(port);
      if (!holder || !(await isOurServer(holder))) break;
      logger.warn(`[opencode] unresponsive server pid ${holder} holds port ${port} — replacing it`);
      try { await terminateServer({ pid: Number(holder) }); } catch (error) { logger.debug(`[opencode] replacement stop: ${error.message}`); }
      await new Promise((r) => setTimeout(r, 500));
    }
    booting = null;
    logger.warn(`[opencode] server did not start${lastFail ? `: ${lastFail}` : ""}`);
    throw new Error(`opencode server did not start${lastFail ? ` (${lastFail})` : ""}`);
  })();

  try {
    return await booting;
  } finally {
    booting = null;
  }
}

function serverPort() {
  return OPENCODE_SERVER_PORT;
}

// How long the server outlives its last chat session: long enough that closing
// one pane and opening another does not pay the boot again, short enough that a
// deleted session does not leave an `opencode serve` process running for good.
const SERVER_IDLE_STOP_MS = 30000;
let sessionCount = 0;
let idleStopTimer = null;
// Test-only override for SERVER_IDLE_STOP_MS so retire paths run in milliseconds.
let testIdleMs = null;

/** Arm the idle retirement if no chat session holds the server. */
function armIdleStop() {
  if (sessionCount > 0 || idleStopTimer) return;
  idleStopTimer = setTimeout(() => {
    idleStopTimer = null;
    if (sessionCount > 0) return;
    // Only servers WE spawned (now, or in an earlier agent run): one the user
    // started by hand carries no marker and is not ours to stop.
    // The ids belong to the retiring server; a fresh one repopulates on create.
    v2Sessions.clear();
    if (proc) { terminateServer(proc).catch((error) => logger.warn(`[opencode] idle stop failed: ${error.message}`)); return; }
    if (adoptedOurs) {
      const target = adoptedOurs;
      adoptedOurs = null;
      base = null;
      terminateServer({ pid: target }).catch((error) => logger.warn(`[opencode] idle stop failed: ${error.message}`));
      clearMarker();
    }
  }, testIdleMs ?? SERVER_IDLE_STOP_MS);
  idleStopTimer.unref?.();
}

/** A chat session started using the server — keeps it alive past idle stops. */
export function retainForSession() {
  sessionCount += 1;
  if (idleStopTimer) { clearTimeout(idleStopTimer); idleStopTimer = null; }
}

/** A chat session went away — the LAST one retires the server we spawned. */
export function releaseForSession() {
  sessionCount = Math.max(0, sessionCount - 1);
  armIdleStop();
}

async function api(method, path, body, { timeoutMs = 30000 } = {}) {
  const url = await ensureServer();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: authHeaders(body === undefined ? {} : { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  // Unmatched /api/* paths answer 200 with the web UI's HTML — never data.
  if ((res.headers.get("content-type") || "").includes("text/html")) {
    throw new Error(`opencode ${path} unavailable (HTML answer — route missing on this server)`);
  }
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const msg = parsed?.message || parsed?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed?.data !== undefined ? parsed.data : parsed;
}

export async function createSession(cwd, extras = {}) {
  const s = await api("POST", "/api/session", { location: { directory: cwd }, ...extras });
  if (s?.id) v2Sessions.add(s.id);
  return s;
}

export const isV2Session = (id) => v2Sessions.has(id);

export async function listMessages(sessionId) {
  await ensureServer();
  if (!modernApi) return api("GET", `/session/${sessionId}/message`);
  const messages = await api("GET", `/api/session/${sessionId}/message?order=desc&limit=${MESSAGE_PAGE_SIZE}`);
  return messages.reverse().map(messageRecord);
}

// Session info including the agent it currently runs (read before a mode PATCH).
export const getSession = (sessionId) => api("GET", `/api/session/${sessionId}`);

// The same PATCH the TUI's rename dialog sends; the server emits session.updated.
export const renameSession = (sessionId, title) => api("PATCH", `/api/session/${sessionId}`, { title });

export const activeSessions = () => api("GET", "/api/session/active");

// Admission returns immediately in OpenCode 2; wait for execution before settling the turn.
export async function prompt(sessionId, body) {
  await ensureServer();
  if (!modernApi) return api("POST", `/session/${sessionId}/message`, typeof body === "string" ? { parts: [{ type: "text", text: body }] } : body, { timeoutMs: OPENCODE_PROMPT_TIMEOUT_MS });
  await api("POST", `/api/session/${sessionId}/prompt`, promptInput(body));
  return api("POST", `/api/experimental/session/${sessionId}/wait`, undefined, { timeoutMs: OPENCODE_PROMPT_TIMEOUT_MS });
}

export const setSessionModel = (sessionId, model) =>
  api("POST", `/api/session/${sessionId}/model`, { model });

// v1 routes on the same serve process: the command menu (GET /command) and
// command execution (POST /session/:id/command) — /api/command is bare on 1.18.x.
const COMMAND_WARMUP_RETRY_MS = 400;

export async function listCommands() {
  await ensureServer();
  const route = modernApi ? "/api/command" : "/command";
  let list = await api("GET", route);
  // First call after boot can answer [] while commands load — retry once.
  if (!Array.isArray(list) || list.length === 0) {
    await new Promise((r) => setTimeout(r, COMMAND_WARMUP_RETRY_MS));
    list = await api("GET", route);
  }
  return Array.isArray(list) ? list : [];
}

export async function runCommand(sessionId, body) {
  await ensureServer();
  if (!modernApi) return api("POST", `/session/${sessionId}/command`, body, { timeoutMs: COMMAND_TIMEOUT_MS });
  await api("POST", `/api/session/${sessionId}/command`, { name: body.command, text: body.arguments || "" }, { timeoutMs: COMMAND_TIMEOUT_MS });
  return api("POST", `/api/experimental/session/${sessionId}/wait`, undefined, { timeoutMs: COMMAND_TIMEOUT_MS });
}

// Mode = agent on the v2 server (build = full access, plan = read-only).
export const setSessionAgent = (sessionId, agent) =>
  api("POST", `/api/session/${sessionId}/agent`, { agent });

// v2 gates: permission/question requests and their replies.
export const requestPermission = (sessionId, body) =>
  api("POST", `/api/session/${sessionId}/permission`, body);

export const pendingPermissions = (sessionId) =>
  api("GET", `/api/session/${sessionId}/permission`);

export async function replyPermission(sessionId, requestId, reply, message = "") {
  await ensureServer();
  return api("POST", `/api/session/${sessionId}/permission/${requestId}/reply`, { [modernApi ? "decision" : "reply"]: reply, ...(message ? { message } : {}) });
}

// The question tool's gates live in the v1 store behind /question — the
// /api/session mirror answers an empty list even for sessions it holds. That store is
// instance state scoped by directory: without the param the server reads the serve
// process's own cwd, a different store than the session's directory.
const scopedQuestion = (path, directory) =>
  directory ? `${path}?directory=${encodeURIComponent(directory)}` : path;

// Pending gates, all sessions in the directory; each entry carries the que_ id
// its reply route wants and the sessionID it blocks.
export async function listPendingQuestions(directory, sessionId) {
  await ensureServer();
  if (!modernApi) return api("GET", scopedQuestion("/question", directory));
  const route = sessionId ? `/api/session/${sessionId}/form` : `/api/form${directory ? `?location=${encodeURIComponent(JSON.stringify({ directory }))}` : ""}`;
  const forms = await api("GET", route);
  for (const [id, form] of pendingForms) {
    if ((!sessionId || form.sessionID === sessionId) && !forms.some((item) => item.id === id)) pendingForms.delete(id);
  }
  return forms.map((form) => { pendingForms.set(form.id, form); return questionRecord(form); });
}

export async function replyQuestion(requestId, answers, directory) {
  await ensureServer();
  if (!modernApi) return api("POST", scopedQuestion(`/question/${requestId}/reply`, directory), { answers });
  const form = pendingForms.get(requestId);
  if (!form) throw new Error("OpenCode question is no longer pending");
  const result = await api("POST", `/api/session/${form.sessionID}/form/${requestId}/reply`, { answer: formAnswer(form, answers) });
  pendingForms.delete(requestId);
  return result;
}

export async function rejectQuestion(requestId, directory) {
  await ensureServer();
  if (!modernApi) return api("POST", scopedQuestion(`/question/${requestId}/reject`, directory));
  const form = pendingForms.get(requestId);
  if (!form) throw new Error("OpenCode question is no longer pending");
  const result = await api("DELETE", `/api/session/${form.sessionID}/form/${requestId}`);
  pendingForms.delete(requestId);
  return result;
}

export async function interruptSession(sessionId) {
  const url = await ensureServer();
  const res = await fetch(`${url}/api/session/${sessionId}/interrupt`, { method: "POST", headers: authHeaders(), signal: AbortSignal.timeout(10000) });
  if ((res.headers.get("content-type") || "").includes("text/html")) {
    throw new Error(`opencode interrupt unavailable (HTML answer — route missing on this server)`);
  }
  if (!res.ok) throw new Error(`interrupt failed: HTTP ${res.status}`);
}

// Subscribe to global v2 event bus (GET /api/event SSE); caller filters by sessionID.
// onReconnect fires after every successful (re)connection so the caller can
// reconcile state the gap may have missed — the stream itself has no replay.
export function subscribeBus(onEvent, { onReconnect = null } = {}) {
  let closed = false;
  // Aborts the in-flight connect too: close() during the fetch await leaks a
  // live SSE connection nothing will ever read.
  const abort = new AbortController();
  (async function loop() {
    while (!closed) {
      try {
        const url = await ensureServer();
        const res = await fetch(`${url}/api/event`, { headers: authHeaders({ accept: "text/event-stream" }), signal: abort.signal });
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
        if (onReconnect) { try { onReconnect(); } catch {} }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let at;
          while ((at = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, at);
            buf = buf.slice(at + 2);
            const data = frame.split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .join("");
            if (!data) continue;
            try { onEvent(JSON.parse(data)); } catch {}
          }
        }
      } catch {
      }
      if (closed) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return {
    close() {
      // No reader.cancel() here: on an aborted body it rejects with the abort's
      // own AbortError, and nothing is left to catch it (the unhandled
      // rejection on every surface switch). The signal tears the stream down.
      closed = true;
      try { abort.abort(); } catch {}
    }
  };
}

// Stage rewind to messageId and preview file changes without committing.
export const stageRevert = (sessionId, messageId, { files = true } = {}) =>
  api("POST", `/api/session/${sessionId}/revert/stage`, { messageID: messageId, files });

export async function clearRevert(sessionId) {
  await ensureServer();
  return modernApi ? api("DELETE", `/api/session/${sessionId}/revert`) : api("POST", `/api/session/${sessionId}/revert/clear`);
}

export const commitRevert = (sessionId) => api("POST", `/api/session/${sessionId}/revert/commit`);

export const deleteSession = (sessionId) =>
  api("DELETE", `/api/session/${sessionId}`).finally(() => v2Sessions.delete(sessionId));

// Test hook: point api() at a fake server instead of spawning opencode.
export function _useTestBase(url, { modern = false, secret = null } = {}) {
  base = url;
  modernApi = modern;
  password = secret;
  adoptedOurs = null;
  pendingForms.clear();
  // ensureServer short-circuits on a live proc; fake one while overridden.
  proc = url ? { exitCode: null } : null;
  booting = null;
}

// Test hook: swap in a fake server proc and/or adopted pid (to observe retire
// kills without spawning opencode) and shorten the idle window.
export function _useTestProc({ fake = null, adoptedPid = null, idleMs = null } = {}) {
  testIdleMs = idleMs;
  base = fake || adoptedPid ? "http://test" : null;
  proc = fake;
  adoptedOurs = adoptedPid;
  booting = null;
}

export function stopServer() {
  const target = proc || (adoptedOurs ? { pid: adoptedOurs } : null);
  proc = null;
  base = null;
  adoptedOurs = null;
  if (target) clearMarker();
  return terminateServer(target);
}
