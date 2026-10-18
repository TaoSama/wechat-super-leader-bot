/** Only explicitly classified client errors are exposed by the automation HTTP API. */
export class AutomationValidationError extends Error {}
export class AutomationConflictError extends Error {}
