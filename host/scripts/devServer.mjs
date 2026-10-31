import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = dirname(here);
const bin = process.platform === "win32"
  ? join(hostDir, "..", "node_modules", ".bin", "nodemon.cmd")
  : join(hostDir, "..", "node_modules", ".bin", "nodemon");

const child = spawn(bin, ["index.js"], {
  cwd: hostDir,
  env: { ...process.env, NREMOTE_ENV: "development" },
  shell: process.platform === "win32",
  stdio: "inherit"
});

const forward = (signal) => child.kill(signal);
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
