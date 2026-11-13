/** Types for the host-side test import of the in-container driver's pure helpers. */
export declare const OPS: readonly string[];
export declare const MAX_TEXT_BYTES: number;
export declare const MAX_DOWNLOAD_BYTES: number;
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const MAX_TIMEOUT_MS: number;
export declare class RequestError extends Error {}
export declare function validateRequest(req: unknown): Record<string, unknown> & { op: string; pageId: string; timeoutMs: number };
export declare function capText(text: string, max?: number): string;
export declare function safeFileName(raw: string): string;
