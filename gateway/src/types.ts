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
  baseline_established?: boolean;
  baseline_in_progress?: boolean;
  baseline_established_at?: string;
}

export interface InboundWeChatMessage {
  chatId: string;
  text: string;
  messageId: string;
  deliveryKey: string;
  contextToken?: string;
}

export interface ControllerMessageRequest {
  chatId: string;
  messageId: string;
  text: string;
}

export interface ControllerMessageResponse {
  text: string;
  commandId?: string;
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
