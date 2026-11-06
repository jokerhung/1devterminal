// AI replies link files as markdown (`[a.md](/D:/proj/a.md)`, `[a](src/a.js:12)`). In the
// browser such an href resolves against the page origin and 403s on the host, so a link
// that names a file on the host is opened in the editor instead.

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WIN_DRIVE = /^[a-z]:[\\/]/i;
// `#L12`, `#L12C3`, `:12`, `:12:3` at the very end.
const LINE_SUFFIX = /(?:#L(\d+)(?:C(\d+))?|:(\d+)(?::(\d+))?)$/;

const safeDecode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

const joinPath = (base, rel) => `${base.replace(/[\\/]+$/, "")}/${rel.replace(/^\.\//, "")}`;

// → { path, line, column } for a link that names a host file, else null (leave it a link).
export function parseLocalFileLink(href, workspacePath = "") {
  if (!href || href.startsWith("#")) return null;

  let p = href;
  if (/^file:\/\//i.test(p)) p = p.replace(/^file:\/\//i, "");
  else if (SCHEME.test(p) && !WIN_DRIVE.test(p)) return null; // http:, mailto:, ...
  if (p.startsWith("//")) return null; // protocol-relative URL

  p = safeDecode(p);
  const m = LINE_SUFFIX.exec(p);
  const line = m ? Number(m[1] || m[3]) : undefined;
  const column = m ? Number(m[2] || m[4]) || undefined : undefined;
  if (m) p = p.slice(0, m.index);

  // `/D:/x` is the VS Code spelling of a Windows path; the drive letter is the real root.
  if (/^\/[a-z]:[\\/]/i.test(p)) p = p.slice(1);

  const absolute = p.startsWith("/") || WIN_DRIVE.test(p);
  if (!absolute) {
    // A bare relative link means nothing on the web origin: read it as workspace-relative.
    if (!workspacePath || !p) return null;
    p = joinPath(workspacePath, p);
  }
  return { path: p, line, column };
}
