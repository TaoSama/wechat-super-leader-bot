export const MAX_CHAT_ID_LENGTH = 64;
export const MAX_LEADER_DATA_BYTES = 256 * 1024;

export interface LeaderState {
  chatId: string;
  revision: number;
  data: Record<string, unknown>;
  updatedAt: string;
}

export function validateChatId(chatId: string): string {
  if (typeof chatId !== "string") {
    throw new Error("Invalid chatId: must be a string");
  }
  const trimmed = chatId.trim();
  if (
    trimmed.length === 0 ||
    trimmed !== chatId ||
    chatId.length > MAX_CHAT_ID_LENGTH ||
    /[\x00-\x1F\x7F]/.test(chatId)
  ) {
    throw new Error(`Invalid chatId: must be a non-empty string up to ${MAX_CHAT_ID_LENGTH} characters without control characters or outer whitespace`);
  }
  return chatId;
}

export function validateExpectedRevision(expectedRevision: number): number {
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("Invalid expectedRevision: must be a non-negative safe integer");
  }
  return expectedRevision;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateJsonValue(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Invalid leader state data: non-finite numbers (NaN/Infinity) are not allowed");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Invalid leader state data: unsupported value of type ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new Error("Invalid leader state data: circular reference detected");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (!(i in value) || value[i] === undefined) {
          throw new Error("Invalid leader state data: undefined or sparse elements in array are not allowed");
        }
        validateJsonValue(value[i], seen);
      }
      return;
    }
    if (!isPlainObject(value)) {
      throw new Error("Invalid leader state data: only plain objects and arrays are allowed");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("Invalid leader state data: symbol keys are not allowed");
    }
    for (const [k, v] of Object.entries(value)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        throw new Error(`Invalid leader state data: forbidden key '${k}'`);
      }
      if (v === undefined) {
        continue;
      }
      validateJsonValue(v, seen);
    }
  } finally {
    seen.delete(value);
  }
}

export function serializeAndValidateLeaderData(data: Record<string, unknown>): {
  json: string;
  clonedData: Record<string, unknown>;
} {
  if (!isPlainObject(data)) {
    throw new Error("Invalid leader state data: root must be a plain object");
  }
  validateJsonValue(data, new Set());
  const json = JSON.stringify(data);
  if (typeof json !== "string") {
    throw new Error("Invalid leader state data: failed to serialize to JSON");
  }
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_LEADER_DATA_BYTES) {
    throw new Error(`Invalid leader state data: serialized size ${byteLength} bytes exceeds limit of ${MAX_LEADER_DATA_BYTES} bytes`);
  }
  const clonedData = JSON.parse(json) as Record<string, unknown>;
  return { json, clonedData };
}

export function cloneLeaderState(state: LeaderState): LeaderState {
  const { clonedData } = serializeAndValidateLeaderData(state.data);
  return {
    chatId: state.chatId,
    revision: state.revision,
    data: clonedData,
    updatedAt: state.updatedAt,
  };
}
