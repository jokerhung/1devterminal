import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import * as server from "../features/ai/opencodeServer.js";
import { OpenCodeAdapter } from "../features/ai/adapters/opencodeAdapter.js";
import { createOpencodeBusParser } from "../features/ai/opencodeBus.js";

async function withServer(handler, run) {
  const secret = randomBytes(32).toString("hex");
  const calls = [];
  const listener = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const call = { method: req.method, path: req.url, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}`) {
      res.writeHead(401).end();
      return;
    }
    const result = await handler(call);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: result ?? null }));
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  server._useTestBase(`http://127.0.0.1:${listener.address().port}`, { modern: true, secret });
  try { await run(calls); }
  finally {
    server._useTestBase(null);
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  }
}

await test("v2 authenticates attachments and waits for execution after prompt admission", async () => {
  let admitted, finish;
  const waiting = new Promise((resolve) => { admitted = resolve; });
  const finished = new Promise((resolve) => { finish = resolve; });
  await withServer(async ({ path }) => {
    if (path.endsWith("/wait")) { admitted(); await finished; }
    return {};
  }, async (calls) => {
    let settled = false;
    const pending = server.prompt("ses_audit", { parts: [
      { type: "text", text: "Describe this image" },
      { type: "file", mime: "image/png", url: "data:image/png;base64,YQ==" }
    ] }).then(() => { settled = true; });
    try {
      await waiting;
      assert.equal(settled, false);
      assert.equal(calls[0].path, "/api/session/ses_audit/prompt");
      assert.deepEqual(calls[0].body, { text: "Describe this image", files: [{ uri: "data:image/png;base64,YQ==" }] });
    } finally { finish(); await pending; }
  });
});

await test("v2 questions preserve option values and permission decisions", async () => {
  const form = { id: "frm_audit", sessionID: "ses_audit", title: "Choose", fields: [
    { key: "scope", type: "string", title: "Scope", options: [{ label: "Workspace", value: "workspace" }] },
    { key: "confirm", type: "boolean", title: "Confirm" }
  ] };
  await withServer(({ method, path }) => method === "GET" && path.endsWith("/form") ? [form] : null, async (calls) => {
    const [question] = await server.listPendingQuestions("unused", "ses_audit");
    assert.equal(question.questions[0].options[0].label, "Workspace");
    await server.replyQuestion(form.id, [["Workspace"], ["false"]]);
    assert.deepEqual(calls.at(-1).body, { answer: { scope: "workspace", confirm: false } });
    assert.equal(calls.at(-1).path, "/api/session/ses_audit/form/frm_audit/reply");
    await server.replyPermission("ses_audit", "perm_audit", "reject");
    assert.deepEqual(calls.at(-1).body, { decision: "reject" });
  });
});

await test("fast v2 replies are emitted once after the history baseline", async () => {
  const history = [{ id: "old", type: "assistant", time: { completed: 1 }, content: [{ type: "text", text: "Old reply" }] }];
  const events = [];
  await withServer(({ method, path }) => {
    if (method === "GET" && path.includes("/message?")) return history.slice().reverse();
    return [];
  }, async () => {
    const adapter = new OpenCodeAdapter({ onEvent: (type, data) => events.push({ type, data }) });
    await adapter._followTurn("ses_audit", async () => {
      history.push({ id: "new", type: "assistant", time: { completed: 2 }, finish: "stop", content: [{ type: "text", text: "New reply" }] });
    });
    assert.deepEqual(events.filter(({ type }) => type === "delta").map(({ data }) => data.text), ["New reply"]);
    assert.equal(events.filter(({ type }) => type === "turn_complete").length, 1);
  });
});

await test("v2 permission bus events reach the existing approval card", () => {
  const events = [];
  const parser = createOpencodeBusParser({ onEvent: (type, data) => events.push({ type, data }) });
  parser.handle({ type: "permission.asked", data: { id: "perm_audit", action: "edit", resources: ["file.js"] } });
  parser.handle({ type: "permission.replied", data: { requestID: "perm_audit" } });
  assert.deepEqual(events.map(({ type }) => type), ["permission_request", "permission_resolved"]);
  assert.equal(events[0].data.requestId, "perm_audit");
});
