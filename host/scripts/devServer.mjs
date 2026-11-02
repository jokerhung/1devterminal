import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = join(here, "..");
const rootDir = join(hostDir, "..");
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const useNpmCli = existsSync(npmCli);

const nodemonBin = process.platform === "win32"
  ? join(rootDir, "node_modules", ".bin", "nodemon.cmd")
  : join(rootDir, "node_modules", ".bin", "nodemon");

const child = spawn(useNpmCli ? process.execPath : nodemonBin, useNpmCli
  ? [npmCli, "exec", "nodemon", "--", "index.js"]
  : ["index.js"], {
  cwd: hostDir,
  env: { ...process.env, NREMOTE_ENV: "development" },
  shell: !useNpmCli && process.platform === "win32",
  stdio: "inherit"
});

const forward = (signal) => child.kill(signal);
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
