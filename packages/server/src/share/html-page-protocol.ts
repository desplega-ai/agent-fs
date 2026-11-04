/**
 * Constants of the page protocol, shared by the page side
 * (`html-page-bridge.ts`) and the share shell (`html-page-shell.ts`). The live
 * app's host (`live/src/lib/html-page-bridge.ts`) has its own copy: change
 * both together.
 */
export const PAGE_MESSAGE_PREFIX = "agent-fs-page:"
export const PAGE_MAX_IN_FLIGHT = 16
/** 256 KB of content can take about 1.5 MB as JSON when it is all control characters. */
export const PAGE_MAX_MESSAGE_BYTES = 2 * 1024 * 1024
