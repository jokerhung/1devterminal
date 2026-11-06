// Direct file download: the authenticated socket mints a short-lived link, the browser
// then fetches it itself and streams straight to disk — no in-memory Blob, so the cap
// is the user's setting instead of what a tab can hold.
// Trust model: the unguessable token in the path is the only auth on /dl, exactly like
// /preview. It is only ever minted after the socket guard approved the path.

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { DOWNLOAD_LINK_TTL_MS, MAX_DOWNLOAD_LINKS, DOWNLOAD_ROUTE_PREFIX } from "./constants.js";
import { isSensitivePath } from "./pathGuard.js";
import { maxDownloadBytes } from "./fileLimits.js";

// token → { filePath, timer }
const links = new Map();

function dropLink(token) {
  const l = links.get(token);
  if (!l) return;
  clearTimeout(l.timer);
  links.delete(token);
}

// Resolve + vet a file; returns { real, stat } or { error }. Shared by mint and serve:
// serve re-checks because the file (or the limit) may change inside the TTL.
function vetFile(filePath) {
  if (!filePath || typeof filePath !== "string") return { error: "File path required" };
  // Checked before the existence probe so a denied path never reveals whether it exists.
  if (isSensitivePath(filePath)) return { error: "Access denied" };
  let real;
  try { real = fs.realpathSync(filePath); } catch { return { error: "Not found" }; }
  if (isSensitivePath(real)) return { error: "Access denied" };
  const stat = fs.statSync(real);
  if (!stat.isFile()) return { error: "Not a file" };
  const max = maxDownloadBytes();
  if (stat.size > max) return { error: `File too large (${stat.size} bytes). Download limit is ${max} bytes — raise it in Settings.` };
  return { real, stat };
}

export function mintDownloadLink(filePath) {
  try {
    const v = vetFile(filePath);
    if (v.error) return { success: false, error: v.error };
    // Evict the oldest link when the cap is hit rather than refusing the download.
    while (links.size >= MAX_DOWNLOAD_LINKS) dropLink(links.keys().next().value);
    const token = randomBytes(24).toString("base64url");
    const timer = setTimeout(() => dropLink(token), DOWNLOAD_LINK_TTL_MS);
    timer.unref?.();
    links.set(token, { filePath: v.real, timer });
    return {
      success: true,
      url: `${DOWNLOAD_ROUTE_PREFIX}${token}`,
      fileName: path.basename(v.real),
      size: v.stat.size
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function endText(res, code, msg) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(msg);
}

// RFC 6266: ASCII fallback plus the UTF-8 name, so non-Latin filenames survive.
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Single "bytes=a-b" range — enough for browser resume. Null = not satisfiable.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start; let end;
  if (m[1] === "") { // suffix: last N bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}

// Route handler for GET /dl/:token — public in the router table (token is the auth).
export function handleDownloadRequest(req, res, { pathname }) {
  const token = pathname.slice(DOWNLOAD_ROUTE_PREFIX.length);
  const link = links.get(token);
  if (!link) { endText(res, 404, "Download link expired"); return; }

  const v = vetFile(link.filePath);
  if (v.error) { dropLink(token); endText(res, 403, v.error); return; }

  const size = v.stat.size;
  const base = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": contentDisposition(path.basename(v.real)),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };

  let status = 200;
  let range = { start: 0, end: size - 1 };
  if (req.headers.range) {
    const r = parseRange(req.headers.range, size);
    if (!r) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    status = 206;
    range = r;
    base["Content-Range"] = `bytes ${r.start}-${r.end}/${size}`;
  }
  res.writeHead(status, { ...base, "Content-Length": range.end - range.start + 1 });
  if (req.method === "HEAD" || size === 0) { res.end(); return; }
  fs.createReadStream(v.real, range)
    // Headers are already sent — a mid-stream failure can only tear down the socket.
    .on("error", () => res.destroy())
    .pipe(res);
}
