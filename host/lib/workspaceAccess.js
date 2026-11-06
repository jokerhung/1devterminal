import path from "node:path";
import { canonicalize, isSensitivePath } from "../features/fileExplorer/pathGuard.js";
import { findGitRoot } from "../features/terminal/workspaceMigration.js";
import { findKey, updateKeyPermissions } from "../cli/utils/state.js";

const ACCESS_DENIED = "Workspace access denied";
const SESSION_EVENTS = new Set([
  "input", "resize", "session-resume", "upload-file", "clipboard-attach", "joinSession",
  "requestHistory", "aiHistory", "peekSeq", "requestGap", "deleteSession", "renameSession",
  "getNote", "saveNote", "claimAgentSession", "setSessionMode", "clearStatus", "clearNotification",
  "ai:create", "ai:prompt", "ai:attachChunk", "ai:permission", "ai:question", "ai:stop", "ai:stopTask",
  "ai:restart", "ai:options", "ai:destroy", "ai:rewind", "ai:peekSeq", "aiSince",
  "ai:queueRemove", "ai:queueClear"
]);
const READ_EVENTS = new Set([
  "getSessions", "getWorkspaces", "getGroups", "getShells", "getAgentClis", "getSystemInfo",
  "getStatusState", "getNotificationState", "getSessionTasks", "ai:list", "caps", "visibilityChange",
  "fileLimits:get"
]);
const PATH_EVENTS = {
  getFiles: ["dirPath"], getFileTree: ["dirPath"], watchDir: ["dirPath"], unwatchDir: ["dirPath"],
  searchFiles: ["workspace"], searchInFiles: ["workspace"], replaceInFiles: ["workspace"],
  readFile: ["filePath"], readMedia: ["filePath"], readImage: ["filePath"], writeFile: ["filePath"],
  createItem: ["itemPath"], deleteItem: ["itemPath"], copyItem: ["srcPath", "destPath"],
  renameItem: ["oldPath", "newPath"], "download:start": ["filePath"], "download:link": ["filePath"], "streamMedia:start": ["filePath"],
  "upload:start": ["targetDir"], getAgentSessions: ["cwd"], deleteAgentSession: ["cwd"],
  "ai:files": ["workspace"]
};
const TRANSFER_EVENTS = new Set(["file-bin", "upload:end", "upload:cancel", "download:cancel"]);
const WORKSPACE_EVENTS = new Set(["renameWorkspace", "renameGroup", "deleteWorkspace", "deleteGroup", "setWorkspaceHiddenRepos"]);
const PUBLIC_OUTPUT = new Set([
  "terminal:ready", "srvCaps", "serverInfo", "tunnel:updated", "workspacesChanged", "groupsChanged",
  "sessionsChanged", "statusState", "notificationState", "dirChanged", "sessionTasks",
  "upload:progress", "download:done", "download:error", "rtc:enabled", "__ack"
]);
const SESSION_OUTPUT = new Set(["sessionClosed", "statusCleared", "notificationCleared"]);
const fold = (value) => process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;

export function createWorkspaceAccess({ record, localUi = false, workspaces, sessions, sessionWorkspaces }) {
  const unrestricted = localUi || (!!record && !Array.isArray(record.workspaceIds));
  const canCreateWorkspace = unrestricted || record?.canCreateWorkspace === true;
  const workspaceIds = new Set(record?.workspaceIds || []);
  const roots = [...workspaceIds].map((id) => workspaces.get(id)?.path).filter(Boolean).map(canonicalize).filter(Boolean);
  const canWorkspace = (id) => unrestricted || (workspaceIds.has(id) && workspaces.has(id));
  const knownSessionWorkspaces = new Map(Object.entries(sessionWorkspaces));
  const canSession = (id) => {
    if (unrestricted) return true;
    if (typeof id !== "string" || !sessions.has(id) || !canWorkspace(sessionWorkspaces[id])) return false;
    knownSessionWorkspaces.set(id, sessionWorkspaces[id]);
    return true;
  };
  const canPath = (input) => {
    if (unrestricted) return true;
    if (typeof input !== "string" || !input || input.includes("\0")) return false;
    if (!path.isAbsolute(input) && !input.startsWith("~")) return false;
    try {
      if (isSensitivePath(input)) return false;
      const target = canonicalize(input);
      return roots.some((root) => {
        const relative = path.relative(fold(root), fold(target));
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
      });
    } catch { return false; }
  };
  const rowAllowed = (row) => (!row.openSessionId || canSession(row.openSessionId)) && canPath(row.cwd || row.path || row.workspacePath);
  const filterMap = (data) => Object.fromEntries(Object.entries(data || {}).filter(([id]) => canSession(id)));
  const filterRows = (rows) => Array.isArray(rows) ? rows.filter(rowAllowed) : [];
  const grantWorkspace = (id) => {
    if (unrestricted) return true;
    const current = findKey(record?.key);
    if (current?.canCreateWorkspace !== true || !Array.isArray(current.workspaceIds)) return false;
    const updated = updateKeyPermissions(current.key, [...current.workspaceIds, id], true);
    if (!updated) return false;
    workspaceIds.add(id);
    return true;
  };

  function allows(event, data) {
    if (unrestricted) return true;
    if (READ_EVENTS.has(event) || TRANSFER_EVENTS.has(event)) return true;
    if (event === "createWorkspace" || event === "createGroup") return canCreateWorkspace && (!data?.path || canPath(data.path));
    if (SESSION_EVENTS.has(event)) {
      const id = typeof data === "string" ? data : data?.sessionId;
      if (!canSession(id)) return false;
      if (data?.cwd && !canPath(data.cwd)) return false;
      if (event.startsWith("ai:") && !canPath(sessions.get(id)?.cwd || sessions.get(id)?.workspacePath)) return false;
      if (data?.attachments?.some((attachment) => attachment.path && !canPath(attachment.path))) return false;
      return true;
    }
    if (event === "createSession") {
      const workspace = workspaces.get(data?.workspaceId ?? data?.groupId);
      return !!workspace?.path && canWorkspace(workspace.id) && canPath(data?.cwd || workspace.path) && (!data?.replaces || canSession(data.replaces));
    }
    if (event === "moveSession") return canSession(data?.sessionId) && canWorkspace(data?.workspaceId ?? data?.groupId);
    if (WORKSPACE_EVENTS.has(event)) return canWorkspace(data?.workspaceId || data?.groupId);
    if (event === "reorderSession") return Array.isArray(data?.orderedIds) && data.orderedIds.every(canSession);
    if (event === "searchAgentSessions") return true;
    if (PATH_EVENTS[event]) {
      if (!PATH_EVENTS[event].every((field) => canPath(data?.[field]))) return false;
      if (event === "upload:start" && !canPath(path.resolve(data.targetDir, data.relativePath || ""))) return false;
      if (event === "replaceInFiles" && (!Array.isArray(data.files) || !data.files.every(canPath))) return false;
      return true;
    }
    if (event.startsWith("git")) {
      const root = data?.repoPath || data?.rootPath;
      if (!canPath(root)) return false;
      const gitRoot = data?.repoPath && findGitRoot(root);
      if (gitRoot && !canPath(gitRoot)) return false;
      for (const field of ["file", "filePath", "worktreePath"]) {
        if (data[field] && !canPath(path.resolve(root, data[field]))) return false;
      }
      if (data?.files && (!Array.isArray(data.files) || !data.files.every((file) => typeof file === "string" && canPath(path.resolve(root, file))))) return false;
      return true;
    }
    return false;
  }

  function filterReply(event, value) {
    if (unrestricted || !value) return value;
    if (event === "getSessions") return value.filter((row) => canSession(row.id));
    if (event === "getWorkspaces" || event === "getGroups") return value.filter((row) => canWorkspace(row.id));
    if (event === "getSystemInfo") return { ...value, homedir: roots[0] || null, drives: roots };
    if (event === "getSessionTasks") return filterMap(value);
    if (event === "getAgentSessions" || event === "searchAgentSessions") return { ...value, sessions: filterRows(value.sessions) };
    if (event === "ai:list") return { ...value, sessions: value.sessions?.filter((row) => canSession(row.id || row.sessionId)) || [] };
    if (typeof value !== "object" || Array.isArray(value)) return value;
    const result = { ...value };
    const cleanRows = (rows) => rows.filter((row) => typeof row !== "object" || !row.path || canPath(row.path)).map((row) => row && Array.isArray(row.children) ? { ...row, children: cleanRows(row.children) } : row);
    for (const field of ["files", "results", "repos", "worktrees"]) {
      if (Array.isArray(value[field])) result[field] = cleanRows(value[field]);
    }
    if (value.parentPath && !canPath(value.parentPath)) result.parentPath = null;
    return result;
  }

  function output(event, args) {
    if (event === "serverInfo") return [{
      ...args[0],
      canCreateWorkspace,
      workspaceScoped: !unrestricted,
      ...(!unrestricted ? { remoteAvailable: false, mobileAvailable: false, canSelfUpdate: false, voiceConfig: null } : {})
    }, ...args.slice(1)];
    if (unrestricted || event.startsWith("device:")) return args;
    const data = args[0];
    if (event === "statusState" || event === "notificationState") return [filterMap(data), ...args.slice(1)];
    if (SESSION_OUTPUT.has(event)) return canSession(data) || (event === "sessionClosed" && canWorkspace(knownSessionWorkspaces.get(data))) ? args : null;
    if (data?.sessionId) return canSession(data.sessionId) ? args : null;
    if (event === "dirChanged" || event === "fileChange") return canPath(data?.dirPath || data?.path) ? args : null;
    return PUBLIC_OUTPUT.has(event) ? args : null;
  }

  return { unrestricted, canCreateWorkspace, grantWorkspace, workspaceIds, canWorkspace, canSession, canPath, allows, filterReply, output };
}

// Guard registered feature listeners on both Socket.IO and RTC HostBus.
export function guardWorkspaceHandlers(socket, access) {
  socket.data.workspaceAccess = access;
  const originalOn = socket.on;
  socket.on = function (event, listener) {
    if (event === "disconnect" || event.startsWith("device:")) return originalOn.call(this, event, listener);
    return originalOn.call(this, event, (...args) => {
      const ackIndex = args.findIndex((arg) => typeof arg === "function");
      const ack = ackIndex >= 0 ? args[ackIndex] : null;
      let allowed;
      try { allowed = access.allows(event, args[0]); }
      catch { allowed = false; }
      if (!allowed) {
        const error = (event === "createWorkspace" || event === "createGroup") && !access.canCreateWorkspace
          ? "This key cannot create workspaces" : ACCESS_DENIED;
        ack?.({ ok: false, success: false, error });
        return;
      }
      if (ack) args[ackIndex] = (...reply) => ack(access.filterReply(event, reply[0]), ...reply.slice(1));
      return listener(...args);
    });
  };
}
