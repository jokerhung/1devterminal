import { setTimeout as delay } from "node:timers/promises";
import { CODEX_CONFIG_RETRY_DELAYS_MS } from "./constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("codex-config");

export function isCodexConfigError(error) {
  return /failed to load configuration\b/i.test(error?.message || "");
}

// Retry only explicit configuration rejections; an accepted turn must never be sent twice.
export async function retryCodexConfig(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isCodexConfigError(error) || attempt >= CODEX_CONFIG_RETRY_DELAYS_MS.length) throw error;
      logger.warn(`Configuration read rejected; retry ${attempt + 1}/${CODEX_CONFIG_RETRY_DELAYS_MS.length}`);
      await delay(CODEX_CONFIG_RETRY_DELAYS_MS[attempt]);
    }
  }
}
