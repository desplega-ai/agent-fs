// Remove large encoded payloads before chunking text for embedding.
export function stripBase64(content: string): string {
  return content
    // The MIME part is bounded, so a run of "data:" without a payload costs linear time.
    .replace(/(data:[^,\s"'()<>]{0,200};base64,)[A-Za-z0-9+/_=-]{100,}/gi, "$1[omitted]")
    // The lookbehind starts a match only at the start of a run, so long runs
    // under 1000 characters cost linear time, not quadratic.
    .replace(/(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{1000,}/g, "[base64 omitted]");
}
