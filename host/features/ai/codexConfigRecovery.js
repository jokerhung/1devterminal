import { setTimeout as delay } from "node:timers/promises";
import { CODEX_CONFIG_RETRY_DELAYS_MS, CODEX_WRITER_RETRY_DELAYS_MS } from "./constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("codex-config");

export function isCodexConfigError(error) {
  return /failed to load configuration\b/i.test(error?.message || "");
}

export function isCodexWriterConflict(error) {
  return /already has an active writer/i.test(error?.message || "");
}

// Retry only explicit configuration rejections; an accepted turn must never be sent twice.
// `writerConflict` also retries a startup refused because the thread's previous writer
// (this chat's own stale app-server) had not released it yet — startup only, never a turn.
export async function retryCodexConfig(operation, { writerConflict = false } = {}) {
  let writerRetries = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (writerConflict && isCodexWriterConflict(error)) {
        if (writerRetries >= CODEX_WRITER_RETRY_DELAYS_MS.length) throw error;
        logger.warn(`Thread writer still held; restart ${writerRetries + 1}/${CODEX_WRITER_RETRY_DELAYS_MS.length}`);
        await delay(CODEX_WRITER_RETRY_DELAYS_MS[writerRetries++]);
        continue;
      }
      if (!isCodexConfigError(error) || attempt >= CODEX_CONFIG_RETRY_DELAYS_MS.length) throw error;
      logger.warn(`Configuration read rejected; retry ${attempt + 1}/${CODEX_CONFIG_RETRY_DELAYS_MS.length}`);
      await delay(CODEX_CONFIG_RETRY_DELAYS_MS[attempt]);
    }
  }
}
