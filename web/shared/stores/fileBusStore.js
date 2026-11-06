"use client";

import { create } from "zustand";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { FILE_REQUEST_TIMEOUT_MS, normalizePathsResponse } from "@/features/fileExplorer/constants/fileExplorer.js";
import { uploadFiles as transferUpload, downloadFile as transferDownload, streamMedia as transferStream } from "@/features/fileExplorer/lib/fileTransfer.js";

const normResolve = (resolve) => (res) => {
  resolve(normalizePathsResponse(res));
};

// One file API, any bus: the main singleton and every fleet host's facade are the
// same object built over a different bus getter — the only per-host difference.
// `getLiveBus` is the subscription door: unlike one-shot requests it must attach
// the moment the bus object exists (socket.io allows `on` before connect), so a
// watcher registering pre-connect never misses the first events.
// `getHttpOrigin` names where this host answers plain HTTP (for direct /dl links);
// null when unknown, which sends callers down the in-socket path instead.
export function makeFileBus(getBus, getProtocol = () => null, getLiveBus = getBus, getHttpOrigin = () => null) {
  return {
  getSystemInfo: () => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("getSystemInfo", resolve);
  }),

  getFiles: (dirPath, showHidden = false) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    let timer;
    const done = (res) => {
      clearTimeout(timer);
      resolve(normalizePathsResponse(res));
    };
    timer = setTimeout(() => resolve({ success: false, error: "File list request timed out" }), FILE_REQUEST_TIMEOUT_MS);
    bus.emit("getFiles", { dirPath, showHidden }, done);
  }),

  readFile: (filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("readFile", { filePath }, resolve);
  }),

  readImage: (filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("readImage", { filePath }, resolve);
  }),

  readMedia: (filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("readMedia", { filePath }, resolve);
  }),

  writeFile: (filePath, content) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("writeFile", { filePath, content }, resolve);
  }),

  createItem: (itemPath, type) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("createItem", { itemPath, type }, resolve);
  }),

  deleteItem: (itemPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("deleteItem", { itemPath }, resolve);
  }),

  renameItem: (oldPath, newPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("renameItem", { oldPath, newPath }, resolve);
  }),

  copyItem: (srcPath, destPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("copyItem", { srcPath, destPath }, resolve);
  }),

  gitStatus: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitStatus", { repoPath }, normResolve(resolve));
  }),

  gitChangedCount: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitChangedCount", { repoPath }, resolve);
  }),

  gitFileStatus: (repoPath, filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitFileStatus", { repoPath, filePath }, normResolve(resolve));
  }),

  gitDiff: (repoPath, file, status) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitDiff", { repoPath, file, status }, resolve);
  }),

  gitShowMedia: (repoPath, file, ref = "HEAD") => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitShowMedia", { repoPath, file, ref }, resolve);
  }),

  searchFiles: (workspace, query) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("searchFiles", { workspace, query }, normResolve(resolve));
  }),

  gitDiscard: (repoPath, file, status) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitDiscard", { repoPath, file, status }, resolve);
  }),

  searchInFiles: (workspace, query, options = {}) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    const { caseSensitive = false, wholeWord = false, regex = false, includeGlob = "", excludeGlob = "" } = options;
    bus.emit("searchInFiles", { workspace, query, caseSensitive, wholeWord, regex, includeGlob, excludeGlob }, normResolve(resolve));
  }),

  replaceInFiles: (workspace, query, replacement, options = {}, files = []) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    const { caseSensitive = false, regex = false, includeGlob = "", excludeGlob = "" } = options;
    bus.emit("replaceInFiles", { workspace, query, replacement, caseSensitive, regex, includeGlob, excludeGlob, files }, resolve);
  }),

  watchDir: (dirPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("watchDir", { dirPath }, resolve);
  }),

  unwatchDir: (dirPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("unwatchDir", { dirPath }, resolve);
  }),

  onFileChange: (handler) => {
    const bus = getLiveBus();
    if (!bus) return () => {};
    bus.on("fileChange", handler);
    return () => bus.off("fileChange", handler);
  },

  revealInOS: (filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("revealInOS", { filePath }, resolve);
  }),

  openInTerminal: (dirPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("openInTerminal", { dirPath }, resolve);
  }),

  getFileTree: (dirPath, depth = 1, showHidden = false) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("getFileTree", { dirPath, depth, showHidden }, normResolve(resolve));
  }),

  gitBranch: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitBranch", { repoPath }, resolve);
  }),

  gitScanRepos: (rootPath, maxDepth, force) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitScanRepos", { rootPath, maxDepth, force }, resolve);
  }),

  gitWorkspaceChangedCount: (rootPath, maxDepth, force) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitWorkspaceChangedCount", { rootPath, maxDepth, force }, resolve);
  }),

  gitRefreshRepos: (rootPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitRefreshRepos", { rootPath }, resolve);
  }),

  gitWorktreeList: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    let timer;
    const done = (res) => { clearTimeout(timer); resolve(normalizePathsResponse(res)); };
    timer = setTimeout(() => resolve({ success: false, error: "Worktree list request timed out" }), FILE_REQUEST_TIMEOUT_MS);
    bus.emit("gitWorktreeList", { repoPath }, done);
  }),

  gitWorktreeAdd: (repoPath, worktreePath, branch, newBranch) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitWorktreeAdd", { repoPath, worktreePath, branch, newBranch }, resolve);
  }),

  gitWorktreeRemove: (repoPath, worktreePath, opts = {}) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitWorktreeRemove", { repoPath, worktreePath, ...opts }, resolve);
  }),

  gitBranchList: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitBranchList", { repoPath }, resolve);
  }),

  gitBranchCheckout: (repoPath, branch, create) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitBranchCheckout", { repoPath, branch, create }, resolve);
  }),

  gitAdd: (repoPath, files) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitAdd", { repoPath, files }, resolve);
  }),

  gitReset: (repoPath, files) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitReset", { repoPath, files }, resolve);
  }),

  gitCommit: (repoPath, message) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitCommit", { repoPath, message }, resolve);
  }),

  gitPush: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitPush", { repoPath }, resolve);
  }),

  gitPull: (repoPath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitPull", { repoPath }, resolve);
  }),

  gitLog: (repoPath, limit = 50) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitLog", { repoPath, limit }, normResolve(resolve));
  }),

  uploadFiles: (targetDir, items, callbacks) => {
    const bus = getBus();
    if (!bus) {
      callbacks?.onError?.(null, new Error("Not connected"));
      return Promise.resolve();
    }
    return transferUpload({
      bus,
      protocolRef: getProtocol(),
      targetDir,
      items,
      callbacks
    });
  },

  downloadFile: (filePath, callbacks) => {
    const bus = getBus();
    if (!bus) {
      callbacks?.onError?.(new Error("Not connected"));
      return Promise.resolve();
    }
    return transferDownload({
      bus,
      protocolRef: getProtocol(),
      filePath,
      ...callbacks
    });
  },

  streamMedia: (filePath, callbacks) => {
    const bus = getBus();
    if (!bus) {
      callbacks?.onError?.(new Error("Not connected"));
      return { cancel: () => {} };
    }
    return transferStream({
      bus,
      filePath,
      ...callbacks
    });
  },

  // Mint a one-shot browser download URL. `fallback: true` means "no direct route
  // available" (no origin, old host, timeout) — a real refusal comes back without it.
  downloadLink: (filePath) => new Promise((resolve) => {
    const bus = getBus();
    const origin = getHttpOrigin();
    if (!bus || !origin) return resolve({ success: false, fallback: true, error: "No direct route" });
    const timer = setTimeout(() => resolve({ success: false, fallback: true, error: "Host has no direct download" }), FILE_REQUEST_TIMEOUT_MS);
    bus.emit("download:link", { filePath }, (res) => {
      clearTimeout(timer);
      resolve(res?.success ? { ...res, url: origin + res.url } : { ...res, success: false });
    });
  }),

  getFileLimits: () => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    const timer = setTimeout(() => resolve({ success: false, error: "Host does not support file limits" }), FILE_REQUEST_TIMEOUT_MS);
    bus.emit("fileLimits:get", {}, (res) => { clearTimeout(timer); resolve(res); });
  }),

  setFileLimits: (patch) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    const timer = setTimeout(() => resolve({ success: false, error: "Host does not support file limits" }), FILE_REQUEST_TIMEOUT_MS);
    bus.emit("fileLimits:set", patch, (res) => { clearTimeout(timer); resolve(res); });
  }),

  previewStart: (filePath) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("preview:start", { filePath }, resolve);
  }),

  previewEnd: (sessionId) => new Promise((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false });
    bus.emit("preview:end", { sessionId }, resolve);
  })
  };
}

const getMainBus = () => {
  const state = useConnectionStore.getState();
  if (!state.connected) return null;
  return state.busRef?.current || state.bus;
};
const getMainProtocol = () => useConnectionStore.getState().protocolRef;
// Ungated: the bus object existing is enough to subscribe.
const getMainLiveBus = () => {
  const state = useConnectionStore.getState();
  return state.busRef?.current || state.bus;
};

// The origin the main connection actually talks to. An http link from an https page
// is a blocked download (mixed content), so that combination falls back to the socket.
const getMainHttpOrigin = () => {
  const { endpoint } = useConnectionStore.getState();
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.protocol === "http:" && window.location.protocol === "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
};

export const useFileBusStore = create(() => makeFileBus(getMainBus, getMainProtocol, getMainLiveBus, getMainHttpOrigin));
