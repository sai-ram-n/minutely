/**
 * The application's single AiProvider instance.
 *
 * Constructed and shape-checked once at startup. Everything else in the
 * codebase imports getProvider() and never knows which vendor is behind it.
 *
 * To swap providers: add a file implementing the AiProvider shape and change
 * the switch below. Nothing else changes.
 */

import { assertValidProvider } from "./provider.js";
import { createGroqProvider } from "./groqProvider.js";
import { logger } from "../config/logger.js";

/** @type {import("./provider.js").AiProvider | null} */
let provider = null;

/**
 * @returns {import("./provider.js").AiProvider}
 */
export function getProvider() {
  if (!provider) {
    // Validated at construction, so a typo'd or half-written implementation
    // fails loudly at boot rather than mid-meeting.
    provider = assertValidProvider(createGroqProvider());
    logger.info({ provider: provider.name }, "AI provider ready");
  }
  return provider;
}

/** Test seam: swap in a fake provider without touching the network. */
export function setProvider(replacement) {
  provider = replacement ? assertValidProvider(replacement) : null;
}
