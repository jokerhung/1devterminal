import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const useNpmCli = existsSync(npmCli);

// Run npm through its JS entry so the dev flag is passed without a shell.
const child = spawn(useNpmCli ? process.execPath : "npm", useNpmCli
  ? [npmCli, "run", "dev", "--workspace=web"]
  : ["run", "dev", "--workspace=web"], {
  cwd: rootDir,
  env: { ...process.env, NEXT_PUBLIC_DEV_HOST: "1" },
  shell: !useNpmCli && process.platform === "win32",
  stdio: "inherit"
});

const forward = (signal) => child.kill(signal);
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
