import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NotificationDiagnosticError } from "./gateway.js";
import { sanitizeErrorType } from "./runtime/health.js";
import { runCli, NOTIFICATION_DIAGNOSTIC_EXIT_CODE } from "./cli/run.js";

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") return false;
    throw err;
  }
})();

if (isDirectRun) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      if (err instanceof NotificationDiagnosticError) {
        process.exitCode = NOTIFICATION_DIAGNOSTIC_EXIT_CODE;
        return;
      }
      // Desensitized fatal error logging: only log sanitized error classification
      process.stderr.write(`[gateway] fatal: ${sanitizeErrorType(err)}\n`);
      process.exitCode = 1;
    }
  );
}
