// Controller permits a 90s model tool loop plus durable receipt persistence per HTTP attempt.
export const DEFAULT_CONTROLLER_TIMEOUT_MS = 105000;
export const DEFAULT_CONTROLLER_MAX_RETRIES = 2;
export const DEFAULT_POLL_TIMEOUT_MS = 35000;
export const MAX_POLL_TIMEOUT_MS = 120000;
export const POLL_NETWORK_MARGIN_MS = 5000;
export const MAX_POLL_ATTEMPTS = 1;
export const SEND_REQUEST_TIMEOUT_MS = 15000;
export const REPLY_TIMEOUT_MS = 60000; // Bounds the complete multipart reply, including all requests.
export const NOTIFICATION_REPLY_TIMEOUT_MS = 30 * 60 * 1000;
export const CHAT_AUTHORIZATION_TIMEOUT_MS = 10000;
export const CHECKPOINT_MARGIN_MS = 5000;
// A Codex turn can time out while a submitted Controller request is still settling.
export const MAX_CODEX_REQUEST_BUDGET_MS = 630000;
export const MAX_PROCESSING_PHASE_MS = MAX_CODEX_REQUEST_BUDGET_MS + REPLY_TIMEOUT_MS +
  CHAT_AUTHORIZATION_TIMEOUT_MS + CHECKPOINT_MARGIN_MS;
export const MAX_POLL_PHASE_MS = (MAX_POLL_TIMEOUT_MS + POLL_NETWORK_MARGIN_MS) * MAX_POLL_ATTEMPTS + CHECKPOINT_MARGIN_MS;
