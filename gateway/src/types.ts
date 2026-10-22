export interface WeChatAccount {
  token: string;
  accountId: string;
  baseUrl?: string;
  userId?: string;
  savedAt?: string;
}

export interface GatewaySyncState {
  login_fingerprint: string;
  sync_buf: string;
  context_tokens: Record<string, string>;
  processed_message_keys: string[];
  // Track chunk progression for multi-part messages: key -> count of chunks acknowledged
  sent_reply_progress?: Record<string, number>;
  reply_deliveries?: Record<string, ReplyDeliveryState>;
  baseline_established?: boolean;
  baseline_in_progress?: boolean;
  baseline_established_at?: string;
  context_budgets?: Record<string, import("./runtime/context-policy.js").ContextBudgetState>;
  inbound_watermarks?: Record<string, { createdAtMs: number; keys: string[] }>;
  delivery_outbox?: Record<string, DeliveryOutboxItem>;
}

export type DeliveryOutboxSource = "controller" | "engine" | "codex-conflict";

export interface DeliveryOutboxItem {
  kind: "reply" | "notification";
  /** Absent in legacy persisted references, which belong to Controller. */
  source?: DeliveryOutboxSource;
  /** Persisted after the originating engine accepts the terminal delivery receipt. */
  engineAcked?: boolean;
  deliveryKey: string;
  chatId: string;
  messageId: string;
  splitMaxChars: number;
  splitMultiPart: boolean;
  status: "pending" | "claiming" | "claimed" | "defer" | "receipt" | "uncertain" | "expired";
  attemptId?: string;
  deferReason?: import("./runtime/context-policy.js").DeferReason;
  receiptStatus?: "accepted" | "uncertain";
  expiresAt?: number;
  notificationKind?: "completed" | "failed" | "blocked" | "expired" | "progress";
}

export interface ReplyDeliveryState {
  digest: string;
  totalChunks: number;
  acknowledgedChunks: number;
  inFlight: boolean;
  failureReason?: "AttachmentExpired" | "AttachmentUnavailable";
}

export interface InboundWeChatMessage {
  chatId: string;
  text: string;
  messageId: string;
  deliveryKey: string;
  contextToken?: string;
  createdAtMs?: number;
}

export interface ControllerMessageRequest {
  chatId: string;
  messageId: string;
  text: string;
}

export interface ControllerMessageResponse {
  text: string;
  commandId?: string;
  images?: import("./wechat/media-delivery.js").ImageAttachment[];
  /** Engine-local identity of the original request that owns these attachments. */
  imageSourceMessageId?: string;
}

export interface GatewayConfig {
  controllerUrl: string;
  controllerToken: string;
  allowInsecureController: boolean;
  credentialsPath: string;
  statePath: string;
  wechatBaseUrl?: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  runPoll: boolean;
  splitMaxChars: number;
}
