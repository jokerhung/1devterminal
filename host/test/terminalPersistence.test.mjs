import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { daemonSocketPath } from "../features/terminal/daemonSocket.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-terminal-persistence-"));
process.env.NREMOTE_HOME = home;
const { setupSessionHandlers } = await import("../features/terminal/handlers/SessionHandler.js");
const { loadSessionMetadata, loadSessionBuffer } = await import("../features/terminal/ptyHelper.js");

function handlersFor(sessions) {
  const handlers = new Map();
  const socket = { on: (event, fn) => handlers.set(event, fn), emit() {}, data: {} };
  setupSessionHandlers(socket, null, sessions, new Map(), {});
  return (event, payload) => new Promise((resolve, reject) => {
    Promise.resolve(handlers.get(event)(payload, resolve)).catch(reject);
  });
}

try {
  await test("Windows daemon pipes isolate state roots and normalize path casing", () => {
    assert.notEqual(daemonSocketPath("C:\\Users\\one\\.9remote", "win32"), daemonSocketPath("C:\\Users\\two\\.9remote", "win32"));
    assert.notEqual(daemonSocketPath(home, "win32"), daemonSocketPath(`${home}-other`, "win32"));
    assert.equal(daemonSocketPath("C:\\Home\\remote", "win32"), daemonSocketPath("c:\\home\\remote\\", "win32"));
    assert.equal(daemonSocketPath(home, "linux"), path.join(home, "pty-daemon.sock"));
  });

  await test("a fallback terminal persists metadata immediately and restores its shell", async () => {
    const sessions = new Map();
    const call = handlersFor(sessions);
    const created = await call("createSession", { name: "Persistence audit", cwd: home });
    assert.equal(created.success, true);
    const id = created.sessionId;
    const session = sessions.get(id);
    try {
      const metadata = loadSessionMetadata()[id];
      assert.equal(metadata.name, "Persistence audit");
      assert.equal(metadata.cwd, home);
      assert.equal(metadata.shellId, session.shellId);

      const restored = new Map([[id, { ...metadata, buffer: [], needsRestore: true }]]);
      const join = handlersFor(restored);
      const result = await join("joinSession", { sessionId: id, cols: 120, rows: 35 });
      const reopened = restored.get(id);
      try {
        assert.equal(result.success, true);
        assert.ok(reopened.pty);
        assert.equal(reopened.cwd, home);
        assert.equal(reopened.needsRestore, false);
        assert.equal(loadSessionMetadata()[id].cols, 120);
        reopened.pty.write("echo PERSISTENCE_AUDIT\r");
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && !loadSessionBuffer(id, "buffer")?.includes("PERSISTENCE_AUDIT")) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(loadSessionBuffer(id, "buffer")?.includes("PERSISTENCE_AUDIT"));
      } finally {
        if (reopened.pty) {
          const exited = new Promise((resolve) => reopened.pty.onExit(resolve));
          reopened.pty.kill();
          await exited;
        }
      }
    } finally {
      const exited = new Promise((resolve) => session.pty.onExit(resolve));
      session.pty.kill();
      await exited;
    }
  });
} finally {
  assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
  assert.ok(path.basename(home).startsWith("9remote-terminal-persistence-"));
  fs.rmSync(home, { recursive: true, force: true });
}
