/**
 * Upper bound for a client-supplied system prompt (the dev-panel override).
 * Shared between the editor (maxLength + counter) and the chat API schema so
 * the two can't drift.
 */
export const SYSTEM_PROMPT_MAX_CHARS = 20_000;
