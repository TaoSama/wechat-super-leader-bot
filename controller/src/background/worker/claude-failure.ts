import { WorkerExecutionFailure } from "./process.js";

/** Collects native evidence without interrupting a turn that may still recover. */
export class ClaudeFailureEvidence {
  private authenticationFailed = false;
  private toolsObserved = false;

  observe(event: Record<string, any>): void {
    const content = event.message?.content;
    if ((event.type === "assistant" || event.type === "user") && Array.isArray(content) &&
        content.some(item => item?.type === "tool_use" || item?.type === "tool_result")) {
      this.toolsObserved = true;
    }
    if (event.type !== "assistant") return;
    // Native transcripts use camelCase; stream-json uses snake_case. Text is never evidence.
    this.authenticationFailed = event.error === "authentication_failed" &&
      (event.is_api_error_message === true || event.isApiErrorMessage === true);
  }

  failure(): WorkerExecutionFailure | undefined {
    if (!this.authenticationFailed) return undefined;
    return new WorkerExecutionFailure("Worker provider authentication failed", false, {
      category: "authentication_failed",
      executionEvidence: this.toolsObserved ? "tool_activity_observed" : "unverified",
    });
  }
}
