// One signed webhook POST. Used inline by `webhook-test` and by the delivery
// worker. Never throws: every failure comes back as `error`.

import { VERSION } from "../version.js";
import { SEND_TIMEOUT_MS } from "./events.js";
import { webhookFetch } from "./egress.js";
import { signWebhook } from "./signature.js";

/** Bytes of a failed response's body kept as error text. */
export const RESPONSE_SNIPPET_BYTES = 1_024;

export interface SendWebhookInput {
  url: string;
  /** The plaintext `whsec_…` signing secret. */
  secret: string;
  /** Sent as `webhook-id`: the `events.id`, or `ping_<uuid>` for a test. */
  webhookId: string;
  /** The exact JSON body; signed and sent byte for byte. */
  body: string;
  /** Defaults to the egress-guarded `webhookFetch()`. */
  fetchImpl?: typeof fetch;
  /** Clock in epoch ms, for `webhook-timestamp`. Defaults to `Date.now`. */
  now?: () => number;
  /** Per-request timeout. Defaults to SEND_TIMEOUT_MS (15 s). */
  timeoutMs?: number;
  /** Optional extra abort signal (e.g. worker shutdown). */
  signal?: AbortSignal;
}

export interface SendWebhookResult {
  /** True for a 2xx response. */
  ok: boolean;
  statusCode?: number;
  error?: string;
  durationMs: number;
}

/** The Standard Webhooks request headers for one attempt. */
export function webhookHeaders(input: {
  secret: string;
  webhookId: string;
  body: string;
  timestampSec: number;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": `agent-fs-webhooks/${VERSION}`,
    "webhook-id": input.webhookId,
    "webhook-timestamp": String(input.timestampSec),
    "webhook-signature": signWebhook(input.secret, input.webhookId, input.timestampSec, input.body),
  };
}

async function readSnippet(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < RESPONSE_SNIPPET_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, RESPONSE_SNIPPET_BYTES)).trim();
}

function describeError(err: unknown, timeoutMs: number): string {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === "TimeoutError") return `timed out after ${timeoutMs} ms`;
  if (name === "AbortError") return "aborted";
  if (err instanceof Error) return err.name === "Error" ? err.message : `${err.name}: ${err.message}`;
  return String(err);
}

function describeRedirect(statusCode: number, response: Response, requestUrl: string): string {
  const location = response.headers.get("location");
  let target = "no Location header";
  if (location) {
    try {
      target = `Location host ${new URL(location, requestUrl).host}`;
    } catch {
      target = "an invalid Location header";
    }
  }
  return `HTTP ${statusCode}: redirect not followed (${target}); point the webhook at the final URL`;
}

/**
 * POST `body` to `url` with Standard Webhooks headers, a fresh
 * `webhook-timestamp` and a signature over it. Redirects are not followed: a
 * 301/302 after a POST turns into a body-less GET, so following one could
 * record a delivery the receiver never saw. Any 3xx is a failure naming the
 * redirect target's host. Reads at most 1 KB of a non-2xx body for the error
 * text. Egress refusals, timeouts and network errors become
 * `{ ok: false, error }`; this function never throws.
 */
export async function sendWebhook(input: SendWebhookInput): Promise<SendWebhookResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const timeoutMs = input.timeoutMs ?? SEND_TIMEOUT_MS;

  let response: Response;
  try {
    const fetchImpl = input.fetchImpl ?? webhookFetch();
    const timestampSec = Math.floor((input.now ?? Date.now)() / 1000);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
    response = await fetchImpl(input.url, {
      method: "POST",
      headers: webhookHeaders({ ...input, timestampSec }),
      body: input.body,
      signal,
      redirect: "manual",
    });
  } catch (err) {
    return { ok: false, error: describeError(err, timeoutMs), durationMs: elapsed() };
  }

  const statusCode = response.status;
  if (statusCode >= 200 && statusCode < 300) {
    await response.body?.cancel().catch(() => {});
    return { ok: true, statusCode, durationMs: elapsed() };
  }

  if (statusCode >= 300 && statusCode < 400) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, statusCode, error: describeRedirect(statusCode, response, input.url), durationMs: elapsed() };
  }

  let snippet = "";
  try {
    snippet = await readSnippet(response);
  } catch {
    // The status is what counts; a body that fails to read adds nothing.
  }
  const error = `HTTP ${statusCode}${snippet ? `: ${snippet}` : ""}`;
  return { ok: false, statusCode, error, durationMs: elapsed() };
}
