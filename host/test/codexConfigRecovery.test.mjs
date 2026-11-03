// Tests for codex startup/config retry
// Run: node host/test/codexConfigRecovery.test.mjs
import assert from "node:assert/strict";
import { retryCodexConfig, isCodexWriterConflict } from "../features/ai/codexConfigRecovery.js";

let pass = 0, fail = 0;
const test = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log(`  ✓ ${name}`); })
  .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const writerError = () => new Error("thread 01a1 already has an active writer");

console.log("Running codex recovery tests...");

await test("writer conflict is recognised", () => {
  assert.equal(isCodexWriterConflict(writerError()), true);
  assert.equal(isCodexWriterConflict(new Error("boom")), false);
});

await test("writer conflict retries startup, then succeeds", async () => {
  const attempts = [];
  const result = await retryCodexConfig(async (attempt) => {
    attempts.push(attempt);
    if (attempts.length < 3) throw writerError();
    return "ready";
  }, { writerConflict: true });
  assert.equal(result, "ready");
  assert.equal(attempts.length, 3);
});

await test("writer conflict gives up after the bounded retries", async () => {
  let calls = 0;
  await assert.rejects(
    retryCodexConfig(async () => { calls++; throw writerError(); }, { writerConflict: true }),
    /active writer/
  );
  assert.equal(calls, 3);
});

await test("writer conflict is not retried unless asked (turns are never resent)", async () => {
  let calls = 0;
  await assert.rejects(retryCodexConfig(async () => { calls++; throw writerError(); }), /active writer/);
  assert.equal(calls, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
