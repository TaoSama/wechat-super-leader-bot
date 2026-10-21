export declare const DEFAULT_MESSAGE_MAX_CHARS = 3800;
export declare const TRUNCATION_NOTICE = "\n\n[内容过长，已截断]";
export declare function unicodeSafeBoundary(text: string, end: number): number;
export declare function renderMarkdown(text: string, maxChars?: number, layout?: boolean): string;
export declare function markdownToWeChat(text: string, maxChars?: number): string;
export declare function markdownForWeChat(text: string, maxChars?: number): string;
export declare function parseSessionDirectoryQuery(text: string): { status?: "active" | "idle" } | undefined;
export declare function isConsoleLinkQuery(text: string): boolean;
