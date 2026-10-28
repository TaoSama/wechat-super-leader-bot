export declare const DEFAULT_MESSAGE_MAX_CHARS = 3800;
export declare const TRUNCATION_NOTICE = "\n\n[内容过长，已截断]";
export declare function unicodeSafeBoundary(text: string, end: number): number;
/** Reconstructs bodies written by the removed citation-sanitizing delivery release. */
export declare function legacyWeChatCitationBody(text: string): string;
export declare function markdownToWeChat(text: string, maxChars?: number): string;
export declare function parseSessionDirectoryQuery(text: string): { status?: "active" | "idle" } | undefined;
export declare function isConsoleLinkQuery(text: string): boolean;
