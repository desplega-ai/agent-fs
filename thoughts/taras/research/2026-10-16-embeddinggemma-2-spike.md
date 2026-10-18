---
date: 2026-10-16
researcher: Claude
git_commit: 2975e202d00d9a73b7411a169ce65c3ce42361d4
branch: main
repository: agent-fs
topic: EmbeddingGemma 2 spike (local runtimes, multimodal embeddings, PDF text)
tags: [research, spike, search, embeddings, embeddinggemma, multimodal, pdf, node-llama-cpp, transformers-js, llama-cpp]
status: complete
last_updated: 2026-10-16
last_updated_by: Claude
---

# Spike: EmbeddingGemma 2 for agent-fs search

Time box: about 1 hour of wall clock, 2026-10-16 20:10 to 21:10 CEST.
All scripts are throwaway. No production code changed.
All embeddings ran on local models or on a throwaway Hetzner box. No file content went to an external embedding API.
The Hetzner box received only public test inputs.
To write the queries, I (Claude) read file headings and looked at image thumbnails.

## Summary

**Production bug found first.** The `local` provider mis-embeds every chunk longer than 512 tokens.
`LocalEmbeddingProvider` calls `createEmbeddingContext()` with no options.
node-llama-cpp then uses `batchSize = min(contextSize, 512)` (`getDefaultContextBatchSize` in `LlamaContext.js`).
Longer inputs go through the model in 512-token pieces.
nomic-embed-text is a bidirectional encoder, so a split input gives a wrong vector.
On a 649-token chunk, the prod setting gives cosine 0.55 to 0.59 against an independent ONNX reference.
With `contextSize: 2048, batchSize: 2048` the cosine is 0.998.
In the eval corpus, 745 of 1233 chunks (60%) are longer than 512 nomic tokens.
The chunker targets 900 chonkie tokens, but model token counts reach 1059 (nomic) and 1586 (EmbeddingGemma 2).
The fix alone raises R@1 from 0.45 to 0.57 and PDF R@1 from 0.33 to 0.67 (configs A and A' below).
The fix needs a re-index of existing local vectors.
EmbeddingGemma 2 has the same problem in node-llama-cpp (cosine 0.81 on a 574-token chunk at the default batch).

**Q1. node-llama-cpp.** No published version loads the model.
3.17.1 (repo, llama.cpp b8179) and 3.22.1 (latest npm, llama.cpp v0.5.0) both fail with `unknown model architecture: 'gemma-embedding2'`.
A source build of 3.22.1 against llama.cpp b11699 fails to compile: `use of undeclared identifier 'common_batch_add'` in `llama/addon/AddonContext.cpp`.
A 10-line local patch (inline the removed helper) fixes the compile.
The patched build gives correct 768-dim text vectors (min cosine 0.9998), but only with `batchSize` at or above the input token count.
There is no image path. The addon has no `mtmd` or `mmproj` code, and `getEmbeddingFor()` accepts only `Token[] | string | LlamaText`.
An image path needs new native binding code around the llama.cpp `mtmd` C API.

**Q2. llama.cpp native.** Yes, `llama-server` b11699 embeds images.
Start it with `--embeddings --mmproj <mmproj.gguf> -c 8192 -b 8192 -ub 8192`.
Send `POST /v1/embeddings` with `{"input":[{"content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}],"encoding_format":"float"}`.
Plain strings in `input` give text vectors. Text matches the reference (min cosine 0.9998).
Image vectors are close but not exact: cosine 0.957 to 0.984 at default settings.
With `--image-min-tokens 280 --image-max-tokens 280` the range is 0.972 to 0.998.
The BF16 mmproj gives the same numbers as Q8, so quantization is not the cause.
The cause is image preprocessing. By default, llama.cpp uses about 120 tokens per image (the log shows `n_tokens = 121` for most images). The reference processor uses 260 to 266 image tokens.
Text-to-image ranking is still correct (7 of 7 top-1) in every setting.
The physical batch (`-ub`) must be at least the input length, or long inputs fail or split.

**Q3. transformers.js.** Yes. `@huggingface/transformers` 4.3.1 with `onnxruntime-node` 1.30 runs text and image embedding under Bun 1.4.2 on CPU.
q8 is the best choice: text min cosine 0.9999, image min 0.995.
q4 drops to 0.979 (text) and 0.981 (image). fp16 matches q8 quality (0.996) but uses 2.5 GB RSS.
On CPU, q4 and fp16 are not faster than q8.
Bun blocks the `onnxruntime-node` postinstall, but the darwin-arm64 and linux-x64 binaries ship inside the package. Both platforms worked.
Speed on the M2 Pro CPU: 540 to 640 ms per ~574-token chunk, 3.1 to 4.4 s per image.

**Q4. Correctness.** The reference is sentence-transformers 6.1.0 with transformers 5.20.1, fp32, CPU, `google/embeddinggemma-2`.
Inputs: 14 texts (queries, documents, prefixed and raw, one 574-token chunk, code) and 7 public test images.
See the runtime matrix for each runtime's minimum cosine.
Every runtime that embeds images puts them in the text space. Each of 7 text queries ranks its own image first.

**Q5. Retrieval quality.** Native multimodal is the big win. Text-only gains are small.
On 208 files and 40 queries, prod today (A0) scores R@1 0.42, R@5 0.57.
EmbeddingGemma 2 with images and PDF pages (E3) scores R@1 0.75, R@5 1.00.
Text only, EmbeddingGemma 2 beats fixed nomic by about one to three queries (R@1 0.63 vs 0.57). This is near the noise level for this query count.
Prefixes give no clear gain for text-to-text here. They clearly help cross-modal search: image R@5 goes from 0.88 to 1.00, and PDF R@1 from 0.83 to 1.00.
A filename title (`title: {filename}`) does better than `title: none`.
Matryoshka truncation to 256 dims costs R@1 0.75 to 0.63.

**Q6. Performance.** On Apple Silicon with Metal, EmbeddingGemma 2 costs about 2x nomic per chunk (87 to 95 ms vs 41 to 58 ms).
On Linux x86_64 CPU (Hetzner ccx13, 2 dedicated vCPU), a 574-token chunk takes 2.0 to 2.4 s. nomic takes 1.85 s for 649 tokens.
Images are expensive on CPU: 4.7 s at the llama.cpp default budget, 12.4 s (transformers.js) and 19.6 s (llama.cpp) at about 270 tokens.
Memory: 1.3 to 1.7 GB RSS for EmbeddingGemma 2 with vision, against 0.2 to 0.8 GB for nomic.
Downloads: GGUF text 310 MB plus mmproj 555 MB. ONNX q8 text 314 MB plus vision 195 MB plus tokenizer 32 MB.

**Q7. PDF text extraction.** `unpdf` 1.9.0 and `pdfjs-dist` 6.4.299 (legacy build) both work in Bun and give the same text.
They are fast: 1 to 163 ms per PDF, including a 67-page paper.
3 of 8 PDFs return no text at all (two image-only decks and one PDF without a text layer).
One deck returns partly garbled text, likely from a font without a usable Unicode map. An empty-text check does not catch this.
Page rendering for multimodal works in Bun with `unpdf` `renderPageAsImage` plus `@napi-rs/canvas`: 12 to 123 ms per page at 1024 px.

## Runtime matrix

Cosine is against the sentence-transformers fp32 reference. "Speed" is the M2 Pro unless noted. A text chunk is the 574-token test chunk.

| Runtime | Text works | Text min cosine | Image works | Image cosine (min to max) | Text speed | Image speed | Model download |
| --- | --- | --- | --- | --- | --- | --- | --- |
| node-llama-cpp 3.17.1 (repo) | No: `unknown model architecture: 'gemma-embedding2'` | n/a | No | n/a | n/a | n/a | n/a |
| node-llama-cpp 3.22.1 (latest npm) | No: same error | n/a | No | n/a | n/a | n/a | n/a |
| node-llama-cpp 3.22.1, source build on llama.cpp b11699, local patch | Yes | 0.9998 (batch 8192), 0.81 (default batch 512) | No (no mtmd binding) | n/a | 90 ms (Metal) | n/a | 310 MB (Q8_0 GGUF) |
| llama-server b11699 prebuilt, `--mmproj` Q8 | Yes | 0.9998 | Yes | 0.957 to 0.984 (default), 0.972 to 0.998 (280 tokens) | 92 ms (Metal), 2.4 s (Linux CPU) | 166 to 600 ms (Metal), 4.7 to 19.6 s (Linux CPU) | 310 MB + 555 MB mmproj + 12 to 18 MB binary |
| llama-server b11699, `--mmproj` BF16 | Yes | 0.9998 | Yes | 0.960 to 0.984 | same | same | 310 MB + 982 MB mmproj |
| transformers.js 4.3.1, q8, CPU | Yes | 0.9999 | Yes | 0.995 to 0.9996 | 540 to 640 ms (Mac), 2.0 s (Linux) | 3.3 to 4.4 s (Mac), 12.4 s (Linux) | 314 + 195 + 32 MB |
| transformers.js 4.3.1, q4, CPU | Yes | 0.979 | Yes | 0.981 to 0.985 | 610 to 750 ms | 3.1 to 3.4 s | 175 + 109 + 32 MB |
| transformers.js 4.3.1, fp16, CPU | Yes | 1.0000 | Yes | 0.996 to 0.9996 | 560 to 570 ms | 3.3 to 3.7 s | 543 + 336 + 32 MB |

## Retrieval results

Corpus: 208 files from the `swarm` org default drive, read-only.
It has 114 text files (markdown, Python, TypeScript), 86 images (UI screenshots, charts, logos, photos, e2e screenshots), and 8 PDFs.
140 files are distractors that no query targets. Distractors skip every folder that holds a target file.
15 distractor images come from the personal drive (e2e smoke screenshots).
The 7-day window held only 3 distinct PDFs. 5 more PDFs come from older folders (public pitch decks, a carousel, a smoke test).
Text goes through the repo chunker (`chunkContent`). PDF text comes from `unpdf`. PDFs render to page images (first 3 pages).

Queries: 40 hand-written queries, grounded in the files.
- T (11): direct topic lookups (CI runner image change, merge queue failures, Slack approval buttons, a sandbox egress plan, two code files).
- H (15): paraphrased lookups with low word overlap. I added them because the T set saturated.
- I (8): visual targets. Examples: a dinner photo, a spend chart, a token dialog, a logo, a pricing page, a ranked portrait grid.
- P (6): an invoice, a working paper, three pitch decks (one image-only), an image-only carousel, an indexing report.

Scoring: each file scores its best unit (chunk, image, or page). R@k is the share of queries with any relevant file in the top k. MRR uses the first relevant file.
Files that a config cannot index rank last.

| Config | R@1 | R@5 | MRR | T R@1 / R@5 | H R@1 / R@5 | I R@1 / R@5 | P R@1 / R@5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A0 nomic, prod today (batch 512, no prefix, no PDFs, no images) | 0.42 | 0.57 | 0.49 | 0.82 / 0.91 | 0.47 / 0.80 | 0.00 / 0.00 | 0.17 / 0.17 |
| A nomic, batch 512, no prefix, + PDF text | 0.45 | 0.63 | 0.52 | 0.82 / 0.91 | 0.47 / 0.80 | 0.00 / 0.00 | 0.33 / 0.50 |
| A' nomic, batch fixed, no prefix, + PDF text | 0.57 | 0.72 | 0.64 | 0.82 / 0.91 | 0.67 / 0.93 | 0.00 / 0.13 | 0.67 / 0.67 |
| B nomic, batch 512, prefixes, + PDF text | 0.42 | 0.53 | 0.48 | 0.82 / 0.82 | 0.33 / 0.60 | 0.00 / 0.00 | 0.50 / 0.50 |
| B' nomic, batch fixed, prefixes, + PDF text | 0.53 | 0.68 | 0.60 | 0.82 / 0.91 | 0.53 / 0.80 | 0.00 / 0.13 | 0.67 / 0.67 |
| C EG2 text, no prefix, + PDF text | 0.63 | 0.75 | 0.67 | 0.82 / 0.91 | 0.73 / 1.00 | 0.13 / 0.13 | 0.67 / 0.67 |
| D EG2 text, prefixes (`title: none`), + PDF text | 0.57 | 0.78 | 0.66 | 0.82 / 1.00 | 0.60 / 1.00 | 0.13 / 0.13 | 0.67 / 0.67 |
| D' EG2 text, prefixes (`title: {filename}`), + PDF text | 0.63 | 0.78 | 0.68 | 0.91 / 1.00 | 0.67 / 1.00 | 0.13 / 0.13 | 0.67 / 0.67 |
| E1 EG2 D + images + PDF as page images only | 0.75 | 1.00 | 0.85 | 0.82 / 1.00 | 0.60 / 1.00 | 0.75 / 1.00 | 1.00 / 1.00 |
| E2 EG2 D + images + PDF as text only | 0.70 | 0.95 | 0.80 | 0.82 / 1.00 | 0.60 / 1.00 | 0.75 / 1.00 | 0.67 / 0.67 |
| E3 EG2 D + images + PDF text + page images (llama.cpp images) | 0.75 | 1.00 | 0.85 | 0.82 / 1.00 | 0.60 / 1.00 | 0.75 / 1.00 | 1.00 / 1.00 |
| E3t same as E3, images from transformers.js q8 | 0.75 | 1.00 | 0.85 | 0.82 / 1.00 | 0.60 / 1.00 | 0.75 / 1.00 | 1.00 / 1.00 |
| E3n same as E3, no prefixes anywhere | 0.75 | 0.93 | 0.82 | 0.82 / 0.91 | 0.73 / 1.00 | 0.63 / 0.88 | 0.83 / 0.83 |
| E3@256 E3 truncated to 256 dims, re-normalized | 0.63 | 0.95 | 0.77 | 0.64 / 1.00 | 0.47 / 1.00 | 0.63 / 0.75 | 1.00 / 1.00 |

Notes:
- EG2 text vectors come from the patched node-llama-cpp build. They match the reference at cosine 0.9998 or better, as llama-server and transformers.js text do.
- The image rows (I) for text-only configs hit only where a text file is also relevant.
- llama.cpp and transformers.js image vectors give identical rankings, although llama.cpp vectors deviate more from the reference.
- Text queries do not suffer when images share the table. T and H scores are the same in D and E3.
- Before I added distractors (68 files), A0 scored R@1 0.50, R@5 0.65 and E3 scored R@1 0.82, R@5 1.00.
- With 26 text queries, one query moves a T or H score by 0.07 or 0.09. Text-only gaps between nomic and EG2 are within one to three queries.

## Performance

Mac: Apple M2 Pro, 10 cores, 32 GB, Metal. Linux: Hetzner ccx13, 2 dedicated vCPU AMD EPYC Milan, 8 GB, CPU only.
Chunk latency is warm. Corpus means use about 470 tokens per chunk.

| Runtime, host | Download | Cold start | Peak RSS | Text chunk | Short query | Image |
| --- | --- | --- | --- | --- | --- | --- |
| nomic, node-llama-cpp 3.17.1, Mac Metal | 146 MB | 0.1 to 0.3 s (8 s on first load) | 0.4 to 0.8 GB | 41 to 58 ms (mean 475 tokens) | n/a | n/a |
| EG2, node-llama-cpp patched, Mac Metal, ctx 8192 | 310 MB | 2 to 9 s | 0.9 to 1.5 GB | 87 to 95 ms mean, 90 ms at 574 tokens | about 10 ms | n/a |
| EG2, llama-server, Mac Metal | 865 MB | about 6 s | not comparable (Metal memory is outside RSS) | 92 ms | about 10 ms | 166 ms (121 tokens), 525 ms mean (270 to 300 tokens) |
| EG2, transformers.js q8, Mac CPU | 541 MB | 8 s | 1.7 GB | 540 to 640 ms | 45 to 50 ms | 3.3 to 4.4 s |
| EG2, transformers.js q4, Mac CPU | 316 MB | 4.4 s | 1.4 GB | 610 to 750 ms | about 50 ms | 3.1 to 3.4 s |
| EG2, transformers.js fp16, Mac CPU | 911 MB | 13 s | 2.5 GB | 560 to 570 ms | about 50 ms | 3.3 to 3.7 s |
| nomic, llama-server, Linux CPU | 146 MB | under 2 s | 0.2 GB | 1.85 s (649 tokens) | 48 ms | n/a |
| EG2, llama-server, Linux CPU | 865 MB | 2 s | 1.3 GB | 2.4 s (574 tokens) | 62 ms | 4.7 s (121 tokens), 19.6 s (270 tokens) |
| EG2, transformers.js q8, Linux CPU | 541 MB | 4.9 s | 1.5 GB | 2.04 s (574 tokens) | 195 ms | 12.4 s (260 to 266 tokens) |
| sentence-transformers fp32, Mac CPU (reference only) | 1.49 GB | 1.7 s | 1.5 GB | 5.6 to 10 s (under load) | 75 to 800 ms | 20 to 40 s (under load) |

What this means for production (Linux x86_64 CPU):
- Text indexing cost stays close to today. For the same chunk text, EG2 takes about 1.1x (transformers.js) to 1.3x (llama.cpp) the nomic time.
- Query latency goes from about 50 ms to 60 ms (llama.cpp) or 200 ms (transformers.js).
- Image indexing is the real cost. 1000 images take about 1.3 hours at 4.7 s, or 3.4 hours at 12.4 s, on 2 vCPU.
- Memory grows by about 1.1 to 1.3 GB per process. Size the machine for that.

Hetzner cost: one ccx13 in fsn1, about 10 minutes of runtime. The hourly price is EUR 0.069 gross, so the charge is about EUR 0.07.

## Q7 detail: PDF extraction

| PDF (short description) | Pages | unpdf chars | unpdf ms | pdfjs-dist ms | Render ms per page |
| --- | --- | --- | --- | --- | --- |
| Vendor invoice | 2 | 1710 | 112 (first call, warm-up) | 11 | 62 |
| Indexing report | 3 | 6125 | 11 | 5 | 60 |
| Academic working paper | 67 | 126463 | 149 | 163 | 78 |
| Public pitch deck A | 14 | 5248, partly garbled | 17 | 16 | 65 |
| Public pitch deck B (image-only) | 13 | 0 | 2 | 1 | 29 |
| Public pitch deck C | 13 | 2001 (2 empty pages) | 8 | 7 | 123 |
| Carousel (image-only) | 4 | 0 | 1 | 1 | 69 |
| Smoke-test PDF (no text layer) | 1 | 0 | 1 | 0 | 12 |

- `pdfjs-dist` returns 3% to 9% more characters than `unpdf`. My script joins pdf.js text items with spaces, and `unpdf` does not.
- Image-only PDFs are common in decks and carousels. Only page images (E1, E3) found the two image-only targets.
- Garbled text still gets embedded. In this eval the garbled deck was still found, because its first page had clean text.

## Recommendation for steps 2 and 3

**Do now, independent of EmbeddingGemma 2:** fix the batch size in `packages/core/src/search/embeddings/local.ts`.
Pass `contextSize` and `batchSize` to `createEmbeddingContext()`. Use 2048 for nomic.
Then re-index local vectors. This is the cheapest quality gain in this spike.

**Step 1 (PDF text):** use `unpdf`. It works in Bun, is fast, and wraps the same pdf.js engine.
Expect empty text for image-only PDFs. Do not treat empty text as an error.
Consider a heuristic for garbled text (for example, a low share of dictionary-like words) as a later improvement.

**Step 2 (provider refactor and local default):**
- Add `embedQuery` and `embedDocuments`. Use `task: search result | query: {q}` for queries.
- Use `title: {filename} | text: {chunk}` for documents. It beat `title: none` in this eval.
- Pick transformers.js q8 (`onnx-community/embeddinggemma-2-ONNX`) as the local runtime. It is the only runtime that installs from npm and does correct text and image embedding today.
- node-llama-cpp is blocked. No release supports `gemma-embedding2`, its source build needs a patch, and it has no image API.
- A `llama-server` sidecar is the fastest option on Mac, but agent-fs would need to ship and manage a native binary per platform.
- Keep 768 dims. The 256-dim MRL vectors lost 0.12 R@1.
- Plan a full re-index on the model switch. The vector table has the same width, but nomic and EmbeddingGemma 2 vectors are not compatible.
- Set the batch or sequence limit to the max chunk length for any runtime. EmbeddingGemma 2 chunks reached 1586 tokens.

**Step 3 (native multimodal):**
- Embed images natively with the same transformers.js q8 model (`vision_encoder_quantized.onnx`). The vectors match the reference at 0.995 or better.
- Index PDFs as extracted text plus rendered page images (E3). Page images carry the image-only PDFs.
- Treat image embedding as a background job. On 2 vCPU it costs 5 to 20 s per image.
- Test a lower image token budget (`max_soft_tokens` 70) before launch. It should be about 4x cheaper. Its quality is not measured.
- For cloud, gemini-embedding-2 was not tested, because the rules forbid sending content to external APIs.

**Effect of prefixes:** keep them. Text-to-text results are within noise. Cross-modal results improve clearly (image R@5 0.88 to 1.00, PDF R@1 0.83 to 1.00). The model card also says the model was trained with them.

**Blockers and risks:**
- node-llama-cpp has no EmbeddingGemma 2 support and no image API.
- llama.cpp image preprocessing differs from the reference token budget. Rankings did not change here, but vectors are not portable across runtimes.
- CPU image cost on production hardware.
- transformers.js RSS (1.5 to 1.7 GB) is about 2x (Mac) to 7x (Linux) the nomic process.
- A model switch and the batch fix both need a re-index.

## Open questions

- Does a node-llama-cpp release with `gemma-embedding2` support land soon? Is there an upstream issue for `common_batch_add`?
- What does a 70-token image budget do to quality and speed?
- How many PDF pages should we render? This spike used the first 3.
- Does the onnxruntime-node binary ship for linux-arm64 and inside the agent-fs Docker image? This spike checked darwin-arm64 and linux-x64 only.
- Does a GPU or CoreML execution provider help transformers.js on Mac under Bun? Not tested.
- Does score calibration between text and image units hold on a much larger corpus? Here, mixed units did not hurt text queries.
- Does gemini-embedding-2 share a vector space with EmbeddingGemma 2? If not, cloud and local vectors cannot mix.
- Audio support (the 300M audio encoder) was not tested.
- The eval is small (40 queries, 208 files). A larger labelled set is needed to compare text-only models with confidence.

## Reproduction

Everything lives in `/tmp/eg2-spike/`. Scripts are in `scripts/`. Results JSON and logs are in `results/`.
Models, caches, binaries, and `scripts/node_modules` were deleted after the spike. Re-run `bun install` in `scripts/` first.
`data/` (35 MB, the downloaded corpus) and `results/units.json` still hold copies of production file content. Delete them when you no longer need to re-run the eval.

Environment: `HF_HOME=/tmp/eg2-spike/hf-cache`, `UV_CACHE_DIR=/tmp/eg2-spike/uv-cache`. transformers.js uses `env.cacheDir = /tmp/eg2-spike/tjs-cache`.

| Step | Command (from `/tmp/eg2-spike/scripts`) |
| --- | --- |
| Download GGUF, mmproj, llama.cpp | `bun dl.ts <url> <out>` (see URLs in the Q2 section) |
| Correctness inputs | `bun make-corr-inputs.ts` |
| Python reference | `uv run --no-project --python 3.12 --with sentence-transformers==6.1.0 --with transformers==5.20.1 --with torch --with torchvision --with pillow --with accelerate python -I ref.py ../results/corr-inputs.json ../results/vec-ref.json` |
| node-llama-cpp test | `NLC_CTX=8192 NLC_BATCH=8192 bun nlc-embed.ts <node-llama-cpp dir> <model.gguf> ../results/corr-inputs.json <out.json>` |
| node-llama-cpp source build | `./node_modules/.bin/node-llama-cpp source download --release b11699 --gpu metal`. It fails on `common_batch_add`. Inline that helper in `llama/addon/AddonContext.cpp`, then run `node-llama-cpp source build --gpu metal`. |
| llama-server | `./run-llamasrv.sh mmproj-embeddinggemma-2-Q8_0.gguf 18432 --image-min-tokens 280 --image-max-tokens 280`, then `bun llamasrv-embed.ts http://127.0.0.1:18432 ../results/corr-inputs.json <out.json>` |
| transformers.js test | `bun tjs-embed.ts q8 ../results/corr-inputs.json <out.json>` (also `q4`, `fp16`) |
| Compare to reference | `bun compare.ts ../results/vec-ref.json <out.json> <label>` |
| nomic batch check | `bun nomic-check.ts` |
| Corpus download (read-only) | `bun fetch-data.ts`, then `bun fetch-distractors.ts` |
| PDF extraction | `bun pdf-extract.ts ../results/manifest.json ../data/pdf-out` |
| Corpus embedding | `bun embed-corpus.ts nlc <dir> <gguf> nomic\|eg2 <name> [ctx] [batch]`, `bun embed-corpus.ts srv <url> eg2-srv`, `bun embed-corpus.ts tjs q8 eg2-tjs` |
| Retrieval eval | `bun eval.ts` (queries in `queries.ts`) |
| Linux CPU run | `remote-setup.py` on the box, then the same `llamasrv-embed.ts` and `tjs-embed.ts` commands |

Key result files: `results/eval-full.txt` (208 files), `results/retrieval-small.json` (68 files), `results/vec-*.json` (correctness vectors), `results/emb-*.json` (corpus vectors), `results/manifest.json`, `results/llama-server-*.log`, `results/nlc-build*.log`.
