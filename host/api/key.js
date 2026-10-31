/**
 * API key management handlers (localhost-only)
 */

import { jsonOk, jsonErr } from "../lib/router.js";
import { loadKey, loadKeys, findKey, saveKey, saveAdditionalKey, updateKeyPermissions, removeAdditionalKey, loadSettings } from "../cli/utils/state.js";
import { generateApiKeyV2 } from "../cli/utils/apiKey.js";
import { getConsistentMachineId } from "../cli/utils/machineId.js";
import { getUiState, updateUiState } from "./ui.js";
import { createTempKey, connectUrlOf, registerSession, unregisterSession } from "../cli/utils/token.js";
import { initSignalingGlobal, syncSignalingKeys, retrySignalingNow, getSignalingState } from "../lib/signalingGlobal.js";
import { headOf } from "../cli/utils/apiKey.js";
import { WORKER_URL } from "../cli/config.js";
import { loadWorkspaces } from "../features/terminal/ptyHelper.js";
import { parseJsonBody } from "../lib/router.js";
import { disconnectKeyClients } from "../transport/server.js";

const KEY_NAME_MAX = 80;
function validateWorkspaceIds(value, res) {
  const known = new Set((loadWorkspaces()?.workspaces || []).map((workspace) => workspace.id));
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !known.has(id))) {
    jsonErr(res, 400, "Select valid workspaces");
    return null;
  }
  return [...new Set(value)];
}

function syncKeyRooms() {
  if (loadSettings().remoteEnabled !== false) syncSignalingKeys(loadKeys().map((record) => headOf(record.key)));
}

/** Remote off = local-only: pairing codes and key registration all live on the
 *  Worker, so these handlers must not reach it. One gate for the whole file. */
function remoteDisabled(res) {
  if (loadSettings().remoteEnabled !== false) return false;
  jsonErr(res, 409, "Remote access is off");
  return true;
}

export async function handleOneTimeKey(req, res) {
  if (remoteDisabled(res)) return;
  const state = getUiState();
  const workerUrl = state.workerUrl || WORKER_URL;
  if (!state.permanentKey) { jsonErr(res, 400, "No permanent key set"); return; }
  const data = await createTempKey(state.permanentKey, workerUrl);
  if (!data) { jsonErr(res, 500, "Temp key creation failed"); return; }
  const qrUrl = connectUrlOf(workerUrl, data);
  updateUiState({ oneTimeKey: data.oneTimeKey, oneTimeKeyExpiresAt: data.expiresAt, qrUrl });
  jsonOk(res, { oneTimeKey: data.oneTimeKey, expiresAt: data.expiresAt, qrUrl });
}

// The boot join can hit the DO's 401 gate (no session row yet) and give up
// permanently; registering the session later must revive it or RTC-only
// clients spin forever in a room the agent never listens to.
export async function handleSignalingRetry(req, res) {
  if (remoteDisabled(res)) return;
  retrySignalingNow("session-registered");
  jsonOk(res, getSignalingState());
}

export async function handleRegenerate(req, res) {
  if (remoteDisabled(res)) return;
  try {
    const state = getUiState();
    const workerUrl = state.workerUrl || WORKER_URL;
    const machineId = await getConsistentMachineId();
    const key = generateApiKeyV2(machineId);
    const existing = loadKey();
    // Register the new key with the Worker BEFORE storing it: without a session
    // row the key cannot resolve a tunnel and every login fails.
    const registered = await registerSession(key, workerUrl, state.tunnelUrl, existing?.key);
    if (!registered) { jsonErr(res, 502, "Could not register the new key with the server"); return; }
    saveKey(machineId, key, existing?.name || "Default");
    if (existing?.key) disconnectKeyClients(headOf(existing.key));
    // The DO signaling room is keyed by the apiKey HEAD, and it was joined at
    // boot with the OLD key. Without rejoining, clients holding the new key land
    // in a room the agent never listens to and spin forever.
    initSignalingGlobal(headOf(key));
    syncKeyRooms();
    // The two keys have separate lifecycles: regenerating this one does NOT
    // mint a pairing code. The old code is still cleared though — it redeems to
    // the key just retired, so keeping it on screen would hand a client a dead
    // key. QR follows the one-time key, so it clears with it. The user mints
    // the next code explicitly (pairingUsed blocks the UI auto-mint).
    updateUiState({ permanentKey: key, oneTimeKey: "", oneTimeKeyExpiresAt: null, qrUrl: "", pairingUsed: true });
    jsonOk(res, { ok: true, permanentKey: key });
  } catch (err) { jsonErr(res, 500, err.message); }
}

/** Create another permanent key while keeping the active host key alive. */
export async function handleCreatePermanentKey(req, res) {
  if (remoteDisabled(res)) return;
  try {
    const body = await parseJsonBody(req, res);
    if (!body) return;
    const workspaceIds = validateWorkspaceIds(body.workspaceIds, res);
    if (!workspaceIds) return;
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > KEY_NAME_MAX) {
      jsonErr(res, 400, `Key name must be between 1 and ${KEY_NAME_MAX} characters`); return;
    }
    if (!loadKey()?.key) { jsonErr(res, 409, "Create the host key first"); return; }
    const state = getUiState();
    const workerUrl = state.workerUrl || WORKER_URL;
    const machineId = await getConsistentMachineId();
    const key = generateApiKeyV2(machineId);
    if (!(await registerSession(key, workerUrl, state.tunnelUrl))) {
      jsonErr(res, 502, "Could not register the new key with the server"); return;
    }
    const record = saveAdditionalKey(machineId, key, body.name.trim(), workspaceIds);
    if (!record) {
      await unregisterSession(key, workerUrl);
      jsonErr(res, 500, "Could not save the new key"); return;
    }
    syncKeyRooms();
    jsonOk(res, { ok: true, key: { ...record, keyHead: headOf(key), active: false } });
  } catch (err) { jsonErr(res, 500, err.message); }
}

export function handleListPermanentKeys(_req, res) {
  const workspaces = loadWorkspaces()?.workspaces || [];
  const active = loadKey()?.key;
  jsonOk(res, { keys: loadKeys().map((key) => ({ ...key, keyHead: headOf(key.key), active: key.key === active })), workspaces });
}

export async function handleUpdateKeyPermissions(req, res) {
  const body = await parseJsonBody(req, res);
  if (!body) return;
  const workspaceIds = validateWorkspaceIds(body.workspaceIds, res);
  if (!workspaceIds) return;
  if (findKey(body.keyHead)?.key === loadKey()?.key) { jsonErr(res, 400, "The host key always has access to all workspaces"); return; }
  const key = updateKeyPermissions(String(body.keyHead || ""), workspaceIds);
  if (!key) { jsonErr(res, 404, "Key not found"); return; }
  disconnectKeyClients(headOf(key.key));
  jsonOk(res, { ok: true, key });
}

export async function handleRevokePermanentKey(req, res) {
  const body = await parseJsonBody(req, res);
  if (!body) return;
  const record = findKey(body.keyHead);
  if (!record || record.key === loadKey()?.key) { jsonErr(res, 400, "Cannot revoke the active key or key not found"); return; }
  const ok = removeAdditionalKey(String(body.keyHead || ""));
  if (!ok) { jsonErr(res, 400, "Cannot revoke the active key or key not found"); return; }
  disconnectKeyClients(headOf(record.key));
  syncKeyRooms();
  try {
    await unregisterSession(record.key, getUiState().workerUrl || WORKER_URL);
  } catch (error) {
    jsonOk(res, { ok: true, warning: `Revoked on this host. Worker cleanup failed: ${error.message}` });
    return;
  }
  jsonOk(res, { ok: true });
}
