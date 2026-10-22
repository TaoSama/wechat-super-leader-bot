export type WorkerStatus = "queued" | "running" | "completed" | "waiting" | "needs_attention" | "failed" | "unknown";

export interface WorkerInput {
  workerId: string;
  invocationId: string;
  task: string;
  preferences?: string[];
  /** Observations are data, never authorization to control their source. */
  input: unknown;
  timeoutMs?: number;
  /** Absolute boundaries survive time spent waiting for execution capacity. */
  launchDeadlineAt?: number;
  executionDeadlineAt?: number;
}

export interface WorkerInspectOptions {
  /** Maintenance can observe an invocation without causing queued work to start. */
  resumeQueued?: boolean;
  /** Restore or extend bounds authorized in the caller's durable schedule. */
  launchDeadlineAt?: number;
  executionDeadlineAt?: number;
}

export interface WorkerArtifact {
  name: string;
  path: string;
  size: number;
  sha256: string;
}

export interface WorkerRuntimeStatus {
  workerId: string;
  invocationId: string;
  status: WorkerStatus;
  summary: string;
  threadId?: string;
  nextCheckAt?: string;
  /** Relative workspace paths until exportArtifacts has copied them. */
  attachments: string[];
  artifacts?: WorkerArtifact[];
  error?: string;
  /** Local durable metadata confirms this invocation was never recorded. */
  receiptMissing?: boolean;
}

export interface WorkerRuntime {
  start(input: WorkerInput): Promise<WorkerRuntimeStatus>;
  inspect(workerId: string, invocationId: string, options?: WorkerInspectOptions): Promise<WorkerRuntimeStatus>;
  cancel(workerId: string, invocationId: string): Promise<void>;
  exportArtifacts(workerId: string, invocationId: string): Promise<WorkerArtifact[]>;
  /** Caller accepts results before cleanup. Active or unexported workers are refused. */
  cleanup(workerId: string): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface WorkerExecutionRequest {
  workspace: string;
  home: string;
  schemaPath: string;
  prompt: string;
  threadId?: string;
  signal: AbortSignal;
  onThread: (threadId: string) => Promise<void>;
  onProcess: (pid: number) => Promise<void>;
}

export interface WorkerExecutor {
  execute(request: WorkerExecutionRequest): Promise<string>;
}

export interface WorkerRuntimeOptions {
  root: string;
  artifactRoot: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  codexPath?: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  executor?: WorkerExecutor;
  onError?: (error: Error) => void;
}
