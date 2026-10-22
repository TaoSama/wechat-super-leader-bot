import { CommandError } from "../commands/service.js";

/** This invocation was deterministically refused before its business effect began. */
export class DirectToolRejectedError extends CommandError {}
