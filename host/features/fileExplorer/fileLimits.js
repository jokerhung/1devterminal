// User-configurable size caps for file preview and download, persisted in settings.json.
import { readSettings, writeSettings } from "../../lib/settings.js";
import { FILE_LIMIT_DEFAULTS_MB, FILE_LIMIT_BOUNDS_MB } from "./constants.js";

const MB = 1024 * 1024;
const KEYS = Object.keys(FILE_LIMIT_DEFAULTS_MB);

const valid = (v) => Number.isInteger(v) && v >= FILE_LIMIT_BOUNDS_MB.min && v <= FILE_LIMIT_BOUNDS_MB.max;

// Stored values are untrusted (hand-edited file): fall back per key, never throw.
export function getFileLimits() {
  const stored = readSettings().fileLimits || {};
  return Object.fromEntries(KEYS.map((k) => [k, valid(stored[k]) ? stored[k] : FILE_LIMIT_DEFAULTS_MB[k]]));
}

export const maxPreviewBytes = () => getFileLimits().maxPreviewMB * MB;
export const maxDownloadBytes = () => getFileLimits().maxDownloadMB * MB;

// Partial patch from a socket client — the trust boundary, so every field is checked.
export function setFileLimits(patch) {
  const next = { ...getFileLimits() };
  for (const k of KEYS) {
    if (patch?.[k] === undefined) continue;
    if (!valid(patch[k])) return { success: false, error: `${k} must be a whole number of MB between ${FILE_LIMIT_BOUNDS_MB.min} and ${FILE_LIMIT_BOUNDS_MB.max}` };
    next[k] = patch[k];
  }
  if (!writeSettings({ fileLimits: next })) return { success: false, error: "Could not save settings" };
  return { success: true, limits: next };
}
