import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const hostDir = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = process.platform === "win32"
  ? join(hostDir, "..", "node_modules", ".bin", "nodemon.cmd")
  : join(hostDir, "..", "node_modules", ".bin", "nodemon");
const modeArgs = process.argv.slice(2);
const child = spawn(bin, ["cli/index.js", ...modeArgs], {
  cwd: hostDir,
  env: { ...process.env, NREMOTE_ENV: "development" },
  shell: process.platform === "win32",
  stdio: "inherit"
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
