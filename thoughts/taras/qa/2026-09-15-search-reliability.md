# Search Reliability QA

## Outcome

The local implementation resolves the reproduced filename and content search failures.
Production acceptance requires deployment and remains pending.

## Environment

- Base: `d5022bb`, version `0.13.5`.
- Bun: `1.4.1`, the repository pin.
- UI: Vite with Chromium through `agent-browser`.
- Browser backend: isolated local storage, two drives, three synthetic documents, and no embedding credentials.
- Pagination backend: disposable MinIO with 1,000 padding objects before the target.

## Automated checks

| Check | Result |
| --- | --- |
| Root tests | 552 passed, 57 existing skips |
| Typecheck | Passed |
| CLI build | Passed |
| Live build | Passed |
| MinIO E2E | 150 passed, 10 existing FUSE skips |
| Local E2E | 131 passed, 16 expected skips |
| S3 regression cases | Continuation tokens, later failures, prefixes, glob, and tree passed |
| Vector regression cases | Drive scope, distinct files, deleted files, missing files, ordering, and K limits passed |
| CLI and MCP raw FTS | Quoted hyphens and advanced AND expressions passed |

The new pagination fixture failed against the old implementation.
That run passed 148 of 150 tests.
The pagination test and an existing later-file glob test failed.
Both passed after the shared S3 listing fix.

The semantic regressions use deterministic embeddings and an in-memory database.
Protocol E2E tests verify response contracts and provider degradation.
They do not claim live embedding quality or deterministic semantic ranking.

## Browser checks

| Scenario | Observed result |
| --- | --- |
| Files: `ai-tinkerers` | One matching filename across the active drive |
| Full-text: `ai-tinkerers` | Matching documents, with a quoted request pattern |
| Full-text: `ai tinkerers` | Matching documents, with quoted terms joined by AND |
| Full-text: `ai thinkerers` | Successful empty state with exact-term guidance |
| HTTP failure | Search failed message and Retry |
| Network failure | Search failed message with the network error |
| Retry | Results restored after removing the synthetic failure |
| Semantic without credentials | Provider explanation displayed |
| Hybrid without credentials | Keyword-only explanation displayed with results |
| Selected nonmatching file | Visible badge and an accurate zero-match count |
| Result activation | Enter opens the content result |
| Escape | Modal closes after its exit transition |
| Delayed earlier request | New query results remain after the older response arrives |
| Drive change | Prior results disappear and the new drive reports zero matches |
| Whitespace in Hybrid and Semantic | Empty input guidance and zero search requests |

Synthetic failures were injected only into local search requests.
No production document was modified during diagnosis or QA.

## Review

### Standards

Batch metadata retrieval replaces per-chunk queries.
Whitespace does not start hidden embedding requests.
Release preparation follows `RELEASING.md`.

### Spec

The review found a mismatch between slash-prefixed selected paths and tree paths.
The fix normalizes the selected path before the selected-state comparison.
Browser QA confirmed the badge after content-result activation.
The Spec recheck passed.

## Limits

- FUSE checks remain separate because this change does not modify FUSE.
- Existing credential-dependent unit tests remain skipped.
- Semantic relevance, spelling correction, and historical index repair remain outside this change.
- Screenshots use synthetic content. The PR contains temporary signed links to those screenshots.
- The original live document still requires verification after an approved deployment.
