import { createHash } from "node:crypto";
import path from "node:path";

export const LEGACY_DAEMON_PIPE = "\\\\.\\pipe\\9remote-pty";

export function daemonSocketPath(root, platform = process.platform) {
  if (platform !== "win32") return path.join(root, "pty-daemon.sock");
  const scope = createHash("sha256").update(path.win32.resolve(root).toLowerCase()).digest("hex").slice(0, 16);
  return `${LEGACY_DAEMON_PIPE}-${scope}`;
}
