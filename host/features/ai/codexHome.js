// A private CODEX_HOME per codex chat: concurrent chats no longer read and write one
// shared ~/.codex/config.toml (the source of "failed to load configuration").
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";
import { reconcileCodexHookTrust } from "../terminal/hookManager.js";
import {
  CODEX_ISOLATED_HOME,
  CODEX_HOME_COPIED_FILES,
  CODEX_HOME_LINKED_DIRS,
  CODEX_HOME_RM_RETRIES,
  CODEX_HOME_RM_RETRY_DELAY_MS
} from "./constants.js";

const logger = createLogger("codex-home");

const AUTH_FILE = "auth.json";
const CONFIG_FILE = "config.toml";

const realCodexHome = () => process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
const safeId = (chatId) => String(chatId).replace(/[^a-zA-Z0-9_-]/g, "_");

export const codexHomeDir = (chatId) => path.join(PATHS.CODEX_HOMES, safeId(chatId));

const mtimeOf = (file) => {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
};

let tmpSeq = 0;
// Copy through a temp file so a reader never sees a half-copied file.
function copyAtomic(src, dst) {
  const tmp = `${dst}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// auth.json mtime of the real home when the chat's copy was last synced — copy-back only if nobody else touched it.
const authBaseline = new Map();
const inflight = new Map();
const releasing = new Map();

function linkDirs(real, dir) {
  for (const name of CODEX_HOME_LINKED_DIRS) {
    const target = path.join(real, name);
    const link = path.join(dir, name);
    fs.mkdirSync(target, { recursive: true });
    if (fs.existsSync(link)) continue;
    // A junction needs no admin rights on Windows.
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  }
}

function syncAuth(real, dir, chatId) {
  const src = path.join(real, AUTH_FILE);
  const dst = path.join(dir, AUTH_FILE);
  const realMtime = mtimeOf(src);
  if (!realMtime) return;
  // A private copy newer than the real one holds a token codex refreshed — keep it.
  if (mtimeOf(dst) < realMtime) copyAtomic(src, dst);
  authBaseline.set(chatId, realMtime);
}

function resolveConfigFiles(real, dir) {
  const file = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf8");
  const tableStart = content.search(/^[ \t]*\[/m);
  const rootEnd = tableStart < 0 ? content.length : tableStart;
  const root = content.slice(0, rootEnd);
  // Keep file references anchored to the original config when its home moves.
  const resolved = root.replace(
    /^([ \t]*(?:model_catalog_json|model_instructions_file)[ \t]*=[ \t]*)("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')(?=[ \t]*(?:#[^\r\n]*)?\r?$)/gm,
    (line, setting, value) => {
      const raw = value.slice(1, -1);
      if (!raw || /^(?:[a-zA-Z]:|[/\\]|~[/\\])/.test(raw)) return line;
      const prefix = JSON.stringify(`${real}${path.sep}`).slice(1, -1);
      const absolute = value.startsWith("'")
        ? JSON.stringify(path.resolve(real, raw))
        : `"${prefix}${value.slice(1)}`;
      return `${setting}${absolute}`;
    }
  );
  if (resolved === root) return;
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    fs.writeFileSync(tmp, resolved + content.slice(rootEnd), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

async function build(chatId) {
  const real = realCodexHome();
  const dir = codexHomeDir(chatId);
  const existed = fs.existsSync(path.join(dir, CONFIG_FILE));
  // auth.json lives here: owner-only on POSIX (ignored on Windows).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Preserve a daemon-held chat's config, repairing only relocated file references.
  if (existed) {
    resolveConfigFiles(real, dir);
    syncAuth(real, dir, chatId);
    linkDirs(real, dir);
    return dir;
  }

  for (const name of CODEX_HOME_COPIED_FILES) {
    const src = path.join(real, name);
    if (fs.existsSync(src)) copyAtomic(src, path.join(dir, name));
  }
  resolveConfigFiles(real, dir);
  authBaseline.set(chatId, mtimeOf(path.join(real, AUTH_FILE)));
  linkDirs(real, dir);

  // Trust keys embed the hooks.json path, so the copy's hooks need their own trust entries.
  if (fs.existsSync(path.join(dir, "hooks.json"))) {
    const { missing, skipped } = await reconcileCodexHookTrust({ home: dir });
    if (skipped || missing.length) logger.warn(`[${chatId}] codex hooks not trusted in private home`);
  }
  return dir;
}

/** The chat's private CODEX_HOME, created on first use; null when isolation is off. */
export async function prepareCodexHome(chatId) {
  if (!CODEX_ISOLATED_HOME || !chatId) return null;
  // A re-created chat must not reuse a home that is about to be deleted.
  await releasing.get(chatId);
  if (!inflight.has(chatId)) {
    inflight.set(chatId, build(chatId).finally(() => inflight.delete(chatId)));
  }
  return inflight.get(chatId);
}

/** Env override for a codex spawn of this chat. */
export async function codexHomeEnv(chatId) {
  const dir = await prepareCodexHome(chatId);
  return dir ? { CODEX_HOME: dir } : {};
}

// Remove a link without touching its target.
function unlink(link) {
  try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
}

async function removeHome(chatId) {
  const real = realCodexHome();
  const dir = codexHomeDir(chatId);
  if (!fs.existsSync(dir)) return;

  const privateAuth = path.join(dir, AUTH_FILE);
  const realAuth = path.join(real, AUTH_FILE);
  const baseline = authBaseline.get(chatId);
  // Keep a token codex refreshed in this home, unless something else rewrote the real file meanwhile.
  if (baseline && mtimeOf(privateAuth) > baseline && mtimeOf(realAuth) === baseline) copyAtomic(privateAuth, realAuth);
  authBaseline.delete(chatId);

  // A failed unlink aborts: a recursive delete through a live link would wipe the real sessions.
  for (const name of CODEX_HOME_LINKED_DIRS) {
    const link = path.join(dir, name);
    if (fs.existsSync(link)) unlink(link);
  }
  await fs.promises.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: CODEX_HOME_RM_RETRIES,
    retryDelay: CODEX_HOME_RM_RETRY_DELAY_MS
  });
}

/** Delete the chat's home once `afterStop` settles (its codex has released the files). */
export function releaseCodexHome(chatId, afterStop = Promise.resolve()) {
  if (!CODEX_ISOLATED_HOME || !chatId) return Promise.resolve();
  // Registered synchronously so a prepare for the same id waits instead of racing the delete.
  const done = Promise.resolve(afterStop)
    .catch(() => {})
    .then(() => removeHome(chatId))
    .catch((err) => logger.warn(`[${chatId}] could not remove codex home: ${err.message}`))
    .finally(() => { if (releasing.get(chatId) === done) releasing.delete(chatId); });
  releasing.set(chatId, done);
  return done;
}

/** Remove homes whose chat is gone; `isActive(chatId)` says which are still wanted. */
export async function sweepCodexHomes(isActive) {
  if (!CODEX_ISOLATED_HOME || !fs.existsSync(PATHS.CODEX_HOMES)) return;
  for (const name of fs.readdirSync(PATHS.CODEX_HOMES)) {
    if (isActive(name) || inflight.has(name) || releasing.has(name)) continue;
    await removeHome(name).catch((err) => logger.warn(`[${name}] sweep could not remove codex home: ${err.message}`));
  }
}
