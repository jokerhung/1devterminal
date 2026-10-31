import { loadKey, loadKeys, loadSettings, findKey } from "../cli/utils/state.js";
import { headOf } from "../cli/utils/apiKey.js";
import { refreshSession } from "../cli/utils/token.js";
import { getUiState } from "../api/ui.js";
import { WORKER_URL, SESSION_HEARTBEAT_INTERVAL_MS } from "../cli/config.js";
import { createLogger } from "./logger.js";

const logger = createLogger("keySessions");
let syncing = false;
let timer = null;

async function refreshAdditionalKeys() {
  if (syncing || loadSettings().remoteEnabled === false) return;
  syncing = true;
  try {
    const active = loadKey()?.key;
    const { workerUrl, tunnelUrl } = getUiState();
    for (const record of loadKeys()) {
      if (record.key === active || !findKey(headOf(record.key))) continue;
      try { await refreshSession(record.key, workerUrl || WORKER_URL, tunnelUrl); }
      catch (error) { logger.warn(`Additional key refresh failed: ${error.message}`); }
    }
  } finally { syncing = false; }
}

export function startKeySessions() {
  if (timer) return;
  refreshAdditionalKeys();
  timer = setInterval(refreshAdditionalKeys, SESSION_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
}
