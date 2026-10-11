// Controller permits a 90s model tool loop plus durable receipt persistence per HTTP attempt.
export const DEFAULT_CONTROLLER_TIMEOUT_MS = 105000;
export const DEFAULT_CONTROLLER_MAX_RETRIES = 2;
export const DEFAULT_POLL_TIMEOUT_MS = 35000;
export const MAX_POLL_TIMEOUT_MS = 120000;
export const MAX_POLL_ATTEMPTS = 2; // One cursor-expiry recovery.
export const SEND_REQUEST_TIMEOUT_MS = 15000;
export const REPLY_TIMEOUT_MS = 60000; // Bounds the complete multipart reply, including all requests.
export const CHECKPOINT_MARGIN_MS = 5000;
export const MAX_PROCESSING_PHASE_MS = DEFAULT_CONTROLLER_TIMEOUT_MS *
  (DEFAULT_CONTROLLER_MAX_RETRIES + 1) + REPLY_TIMEOUT_MS + CHECKPOINT_MARGIN_MS;
export const MAX_POLL_PHASE_MS = MAX_POLL_TIMEOUT_MS * MAX_POLL_ATTEMPTS + CHECKPOINT_MARGIN_MS;
