// iOS 15 Safari throws "invalid group specifier name" on lookbehind and \p{}.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Exact Unicode classes at runtime, ASCII fallback only where \p{} is a parse error (Safari < 16.4).
const unicodePunctLine = (semi) =>
  `export const unicodePunctuation = regexCheck((() => { try { return new RegExp("[\\\\p{P}\\\\p{S}]", "u"); } catch { return /[!-/:-@[-\`{-~]/; } })())${semi}`;

const patches = [
  {
    // Dropping the lookbehind is safe: findEmail re-checks the boundary at runtime via previous().
    pkg: "mdast-util-gfm-autolink-literal",
    file: "lib/index.js",
    from: "/(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)/gu",
    to: "/([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)/g"
  },
  {
    pkg: "micromark-util-character",
    file: "index.js",
    from: "export const unicodePunctuation = regexCheck(/\\p{P}|\\p{S}/u);",
    to: unicodePunctLine(";")
  },
  {
    pkg: "micromark-util-character",
    file: "dev/index.js",
    from: "export const unicodePunctuation = regexCheck(/\\p{P}|\\p{S}/u)",
    to: unicodePunctLine("")
  }
];

// npm may hoist a package to the repo root, keep it under web/, or nest it inside
// another package when versions conflict — so look in every node_modules, not one path.
const MAX_NEST_DEPTH = 4;
function packageDirs(name) {
  const found = [];
  const walk = (modulesDir, depth) => {
    if (!existsSync(modulesDir)) return;
    const direct = path.join(modulesDir, name);
    if (existsSync(direct)) found.push(direct);
    if (depth >= MAX_NEST_DEPTH) return;
    for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      // Scoped packages live one directory deeper.
      const owners = entry.name.startsWith("@")
        ? readdirSync(path.join(modulesDir, entry.name)).map((n) => path.join(modulesDir, entry.name, n))
        : [path.join(modulesDir, entry.name)];
      for (const owner of owners) walk(path.join(owner, "node_modules"), depth + 1);
    }
  };
  for (const base of [path.join(root, "node_modules"), path.join(root, "web", "node_modules")]) walk(base, 0);
  return [...new Set(found.map((dir) => path.resolve(dir)))];
}

for (const patch of patches) {
  const dirs = packageDirs(patch.pkg);
  const targets = dirs.map((dir) => path.join(dir, patch.file)).filter((file) => existsSync(file));
  // Some versions have no dev/ entry; a package that is simply not installed has nothing to patch.
  if (!targets.length) {
    console.warn(`iOS 15 regex patch skipped: ${patch.pkg}/${patch.file} not found`);
    continue;
  }
  for (const file of targets) {
    const text = readFileSync(file, "utf8");
    if (text.includes(patch.to)) continue;
    if (!text.includes(patch.from)) {
      throw new Error(`iOS 15 regex patch did not match ${path.relative(root, file)}`);
    }
    writeFileSync(file, text.replace(patch.from, patch.to));
    console.log(`patched ${path.relative(root, file)}`);
  }
}
