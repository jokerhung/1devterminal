// Browser-native download through the host's /dl link: the browser streams the file
// to disk itself, so size is bounded by the host's setting, not by tab memory.

// Folders arrive as a zip built in-socket and have no direct route.
// Returns null when the caller should use the in-socket path, { started } on success,
// or { error } when the host refused (too large, access denied).
export async function tryDirectDownload(fileBus, file) {
  if (file.type === "folder" || !fileBus.downloadLink) return null;
  const res = await fileBus.downloadLink(file.path);
  if (res.success) {
    const a = document.createElement("a");
    a.href = res.url;
    a.download = res.fileName || file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { started: true };
  }
  return res.fallback ? null : { error: res.error || "Download failed" };
}
