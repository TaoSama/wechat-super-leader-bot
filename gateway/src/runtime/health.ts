import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { writePrivateJsonSync, resolvePath } from "./state.js";
import { DEFAULT_POLL_TIMEOUT_MS, MAX_POLL_ATTEMPTS, CHECKPOINT_MARGIN_MS, MAX_PROCESSING_PHASE_MS, MAX_POLL_PHASE_MS } from "./budgets.js";
import { ILinkSendReceiptError } from "../wechat/send-receipt.js";

export type HealthStatus = "starting" | "healthy" | "processing" | "degraded" | "stopped";

export const DEFAULT_HEALTH_MAX_AGE_MS = 120000;

export interface GatewayHealthData {
  run_id: string;
  pid: number;
  status: HealthStatus;
  started_at: string;
  updated_at: string;
  last_poll_started_at: string | null;
  last_poll_succeeded_at: string | null;
  consecutive_errors: number;
  total_error_count: number;
  last_error_type: string | null;
  last_error_at: string | null;
  phase: { name: "polling" | "processing"; started_at: string; deadline_at: string } | null;
  processed_message_count: number;
}

export function resolveHealthPath(options: {
  healthPath?: string;
  statePath?: string;
  credentialsPath?: string;
}): string {
  if (options.healthPath && options.healthPath.trim()) {
    return resolvePath(options.healthPath.trim());
  }
  const baseStatePath = options.statePath
    ? resolvePath(options.statePath)
    : resolvePath(options.credentialsPath || "~/.super-leader/wechat-account.json") + ".gateway.state.json";
  return path.join(path.dirname(baseStatePath), "health.json");
}

export function sanitizeErrorType(err: unknown): string {
  if (!err) return "UnknownError";
  if (err instanceof ILinkSendReceiptError) return "ILinkSend" + err.reason;
  if (typeof err === "object" && err !== null) {
    const errorObj = err as { name?: string; message?: string };
    const msg = String(errorObj.message || "");
    if (msg.includes("CHAT_NOT_ALLOWED") || errorObj.name === "ChatNotAllowedError") {
      return "ChatNotAllowed";
    }
    const ctrlMatch = msg.match(/^Controller\b.*\bHTTP (\d{3})\b/);
    if (ctrlMatch) return (ctrlMatch[1] === "401" || ctrlMatch[1] === "403" ? "ControllerAuth" : "ControllerHttp") + ctrlMatch[1];
    const ilinkMatch = msg.match(/^WeChat iLink HTTP (\d{3})\b/);
    if (ilinkMatch) return "ILinkHttp" + ilinkMatch[1];
    if (msg === "WeChat iLink returned a non-object JSON response") return "ILinkInvalidResponse";
    if (msg.includes("WeChat getupdates failed")) return "ILinkGetUpdatesError";
    if (msg.includes("WeChat sendmessage failed")) return "ILinkSendMessageError";
    if (errorObj.name === "AbortError" || msg.toLowerCase().includes("aborted") || msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("timed out")) {
      return "TimeoutError";
    }
    const httpMatch = msg.match(/HTTP (\d{3})/);
    if (httpMatch) return "Http" + httpMatch[1];
    if (errorObj.name === "SyntaxError" || msg.includes("InvalidJson")) return "InvalidJsonSyntax";
    if (errorObj.name === "TypeError") return "NetworkError";
    if (errorObj.name === "RangeError") return "RangeError";
    if (msg.includes("Cannot specify multiple mode")) return "InvalidCliMode";
    if (msg.includes("baseline is not established")) return "BaselineNotEstablished";
    if (msg.includes("Baseline is already established")) return "BaselineAlreadyEstablished";
    if (msg.includes("Cannot establish baseline")) return "CannotEstablishBaseline";
    if (msg.includes("Invalid CONTROLLER_URL")) return "InvalidControllerUrl";
    if (msg.includes("Missing CONTROLLER_TOKEN")) return "MissingControllerToken";
    if (msg.includes("WeChat credentials")) return "InvalidWeChatCredentials";
    if (msg.includes("gateway state")) return "InvalidGatewayState";
    if (msg.startsWith("Invalid ") || msg.includes("must be a ")) return "InvalidCliOption";
  }
  return "OperationalError";
}

export class HealthTracker {
  public readonly healthPath: string;
  private currentData: GatewayHealthData | null = null;
  private phaseRevision = 0;

  constructor(healthPath: string) {
    this.healthPath = resolvePath(healthPath);
  }

  public startRun(): GatewayHealthData {
    const now = new Date().toISOString();
    this.currentData = {
      run_id: "run_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex"),
      pid: process.pid,
      status: "starting",
      started_at: now,
      updated_at: now,
      last_poll_started_at: null,
      last_poll_succeeded_at: null,
      consecutive_errors: 0,
      total_error_count: 0,
      last_error_type: null,
      last_error_at: null,
      phase: null,
      processed_message_count: 0,
    };
    this.flush();
    return this.currentData;
  }

  public recordPollStart(budgetMs = DEFAULT_POLL_TIMEOUT_MS * MAX_POLL_ATTEMPTS + CHECKPOINT_MARGIN_MS): void {
    if (!this.currentData) return;
    const now = new Date().toISOString();
    this.currentData.last_poll_started_at = now;
    this.currentData.updated_at = now;
    this.setPhase("polling", budgetMs);
    this.flush();
  }

  private setPhase(name: "polling" | "processing", budgetMs: number): void {
    const maxBudget = name === "processing" ? MAX_PROCESSING_PHASE_MS : MAX_POLL_PHASE_MS;
    if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > maxBudget) throw new Error("Invalid health phase budget");
    this.currentData!.phase = { name, started_at: new Date().toISOString(), deadline_at: new Date(Date.now() + budgetMs).toISOString() };
    this.phaseRevision++;
  }

  public recordMessageStart(budgetMs: number): number | undefined {
    if (!this.currentData) return;
    this.setPhase("processing", budgetMs);
    this.currentData.updated_at = new Date().toISOString();
    this.flush();
    return this.phaseRevision;
  }

  public recordMessageProgress(): void {
    if (!this.currentData) return;
    this.currentData.processed_message_count++;
    this.currentData.updated_at = new Date().toISOString();
    this.currentData.phase = null;
    this.flush();
  }

  public recordProcessingEnd(expectedRevision?: number): void {
    if (!this.currentData) return;
    if (expectedRevision !== undefined && expectedRevision !== this.phaseRevision) return;
    this.currentData.phase = null;
    this.currentData.updated_at = new Date().toISOString();
    this.flush();
  }

  public recordPollSuccess(): void {
    if (!this.currentData) return;
    const now = new Date().toISOString();
    this.currentData.last_poll_succeeded_at = now;
    this.currentData.updated_at = now;
    this.currentData.consecutive_errors = 0;
    this.currentData.status = "healthy";
    this.currentData.phase = null;
    this.flush();
  }

  public recordPollError(err: unknown): void {
    if (!this.currentData) return;
    const now = new Date().toISOString();
    this.currentData.updated_at = now;
    this.currentData.consecutive_errors += 1;
    this.currentData.total_error_count += 1;
    this.currentData.last_error_type = sanitizeErrorType(err);
    this.currentData.last_error_at = now;
    this.currentData.status = "degraded";
    this.currentData.phase = null;
    this.flush();
  }

  public recordStop(): void {
    if (!this.currentData) return;
    const now = new Date().toISOString();
    this.currentData.updated_at = now;
    this.currentData.status = "stopped";
    this.currentData.phase = null;
    this.flush();
  }

  private flush(): void {
    if (!this.currentData) return;
    writePrivateJsonSync(this.healthPath, this.currentData);
  }
}

export interface HealthCheckResult {
  ok: boolean;
  reason?: string;
  status?: HealthStatus;
  runId?: string;
  pid?: number;
  ageMs?: number;
  maxAgeMs?: number;
  consecutiveErrors?: number;
  totalErrorCount?: number;
  lastErrorType?: string | null;
  healthPath: string;
}

export function checkGatewayHealth(
  healthPath: string,
  maxAgeMs: number = DEFAULT_HEALTH_MAX_AGE_MS
): HealthCheckResult {
  const resolved = resolvePath(healthPath);
  if (!fs.existsSync(resolved)) {
    return { ok: false, reason: "HealthFileNotFound", healthPath: resolved };
  }

  let data: GatewayHealthData;
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    data = JSON.parse(raw) as GatewayHealthData;
    if (typeof data !== "object" || data === null) {
      return { ok: false, reason: "InvalidHealthJson", healthPath: resolved };
    }
  } catch (err: unknown) {
    const reason = err instanceof SyntaxError ? "InvalidHealthJson" : "HealthReadError";
    return { ok: false, reason, healthPath: resolved };
  }

  if (typeof data.pid !== "number" || !Number.isSafeInteger(data.pid) || data.pid <= 0 || typeof data.run_id !== "string" || !data.run_id) {
    return { ok: false, reason: "MalformedHealthData", healthPath: resolved };
  }

  if (data.status === "stopped") {
    return {
      ok: false,
      reason: "GatewayStopped",
      status: "stopped",
      runId: data.run_id,
      pid: data.pid,
      healthPath: resolved,
    };
  }

  let processRunning = false;
  try {
    process.kill(data.pid, 0);
    processRunning = true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    processRunning = code === "EPERM";
  }

  if (!processRunning) {
    return {
      ok: false,
      reason: "ProcessNotRunning",
      status: data.status,
      runId: data.run_id,
      pid: data.pid,
      healthPath: resolved,
    };
  }

  if (data.phase !== undefined && data.phase !== null) {
    const phase = data.phase;
    const start = Date.parse(phase.started_at);
    const deadline = Date.parse(phase.deadline_at);
    const maxBudget = phase.name === "processing" ? MAX_PROCESSING_PHASE_MS : MAX_POLL_PHASE_MS;
    if (!["polling", "processing"].includes(phase.name) || !Number.isFinite(start) || !Number.isFinite(deadline) ||
      start > Date.now() || deadline <= start || deadline - start > maxBudget) {
      return { ok: false, reason: "MalformedProcessingPhase", healthPath: resolved };
    }
    return { ok: Date.now() <= deadline, reason: Date.now() > deadline ? "ProcessingDeadlineExceeded" : undefined,
      status: "processing", runId: data.run_id, pid: data.pid, ageMs: Date.now() - start, maxAgeMs: deadline - start,
      consecutiveErrors: data.consecutive_errors, totalErrorCount: data.total_error_count, healthPath: resolved };
  }

  if (typeof data.last_poll_succeeded_at !== "string" || !data.last_poll_succeeded_at) {
    if (data.status === "starting" && typeof data.started_at === "string") {
      const startedAtMs = Date.parse(data.started_at);
      if (Number.isFinite(startedAtMs)) {
        const ageSinceStart = Math.max(0, Date.now() - startedAtMs);
        if (ageSinceStart <= maxAgeMs) {
          return {
            ok: true,
            status: "starting",
            runId: data.run_id,
            pid: data.pid,
            ageMs: ageSinceStart,
            maxAgeMs,
            healthPath: resolved,
          };
        }
      }
    }
    return {
      ok: false,
      reason: "NoSuccessfulPollRecorded",
      status: data.status,
      runId: data.run_id,
      pid: data.pid,
      consecutiveErrors: data.consecutive_errors,
      totalErrorCount: data.total_error_count,
      lastErrorType: data.last_error_type,
      healthPath: resolved,
    };
  }

  const lastSucceededMs = Date.parse(data.last_poll_succeeded_at);
  if (!Number.isFinite(lastSucceededMs)) {
    return {
      ok: false,
      reason: "MalformedPollTimestamp",
      status: data.status,
      runId: data.run_id,
      pid: data.pid,
      healthPath: resolved,
    };
  }

  const ageMs = Math.max(0, Date.now() - lastSucceededMs);
  if (ageMs > maxAgeMs) {
    return {
      ok: false,
      reason: "PollStale",
      status: data.status,
      runId: data.run_id,
      pid: data.pid,
      ageMs,
      maxAgeMs,
      consecutiveErrors: data.consecutive_errors,
      totalErrorCount: data.total_error_count,
      lastErrorType: data.last_error_type,
      healthPath: resolved,
    };
  }

  return {
    ok: true,
    status: data.status,
    runId: data.run_id,
    pid: data.pid,
    ageMs,
    maxAgeMs,
    consecutiveErrors: data.consecutive_errors,
    totalErrorCount: data.total_error_count,
    lastErrorType: data.last_error_type,
    healthPath: resolved,
  };
}
