---
date: 2026-03-14
author: Claude (research)
topic: "Embedding Pipeline: qmd approach + Gemini Embedding 2"
tags: [research, embeddings, qmd, gemini, agent-fs]
status: complete
---

# Embedding Pipeline Research: qmd + Gemini Embedding 2

## qmd's Embedding Architecture

**qmd** (github.com/tobi/qmd) is a local-first CLI search engine for markdown knowledge bases. Combines BM25 keyword search, vector semantic search, and LLM re-ranking — all running locally.

### Embedding Model
- Default: `embeddinggemma-300M-Q8_0.gguf` (768 dimensions)
- Overridable via `QMD_EMBED_MODEL` env var
- Auto-downloads from HuggingFace, cached in `~/.cache/qmd/models/`

### Storage: SQLite + sqlite-vec + FTS5
- `content_vectors`: chunks with hash, sequence, character position
- `vectors_vec`: sqlite-vec vector index
- `documents_fts`: FTS5 full-text index for BM25
- `llm_cache`: cached LLM responses

### Chunking
- ~900 tokens per chunk, 15% (120-token) overlap
- Smart boundary detection: finds natural markdown breaks (sections, paragraphs, code blocks)
- Not hard token cuts

### Key Operational Detail
- `qmd update` = fast FTS5 index only
- `qmd embed` = separate, manual, slow vector generation
- `qmd embed -f` = force re-embed (required when switching models)
- GPU auto-detected (CUDA, Metal, Vulkan), falls back to CPU

### Three Search Modes
- `qmd search` — BM25 keyword
- `qmd vsearch` — vector semantic
- `qmd query` — hybrid: query expansion + BM25 + vector + LLM reranking

## Google Gemini Embedding Models

### Model Comparison

| Feature | gemini-embedding-001 | gemini-embedding-2-preview | OpenAI 3-small | OpenAI 3-large |
|---|---|---|---|---|
| Modalities | Text only | Text, images, video, audio, PDFs | Text only | Text only |
| Max dimensions | 3072 | 3072 | 1536 | 3072 |
| Recommended dims | 768 | 768 | 1536 | 3072 |
| Max input tokens | 8,192 | 8,192 (text) | 8,191 | 8,191 |
| Price per 1M tokens | $0.15 | $0.25 | $0.02 | $0.13 |
| MTEB score | ~62-63 | 68.32 (+5.81 above competitors) | Lower | ~63-65 |
| Task types | 8 types | 8 types + multimodal | General | General |

### Gemini Embedding 2 Key Details
- **MTEB English**: 68.32 (leading by +5.81 points)
- **Code retrieval**: 74.66
- **768d sweet spot**: 67.99 MTEB (near-peak quality at 1/4 storage of 3072d)
- **Multimodal**: 6 images, 120s video, native audio, 6-page PDFs
- **Free tier** included with Gemini API

## Recommendations for agent-fs

### Default Providers by Use Case
- **Cloud/SaaS**: `gemini-embedding-001` (best quality/price for text, 768d) — $0.15/MTok
- **Budget**: `text-embedding-3-small` (cheapest, 1536d truncatable to 768d) — $0.02/MTok
- **Local/OSS**: `embeddinggemma-300M` via node-llama-cpp (768d, zero cost)
- **Future multimodal**: `gemini-embedding-2` when supporting images/PDFs

### Standard Dimension: 768
Both qmd's local model and Gemini's recommended truncation land at 768. OpenAI supports MRL truncation to 768. Use 768 as the standard.

### Chunking Strategy (from qmd)
- 900 tokens per chunk, 15% overlap
- Smart markdown boundary detection
- Directly applicable to agent-fs's markdown-first use case
- For CSVs: embed column names + sample rows (custom strategy needed)

### Architecture Pattern (from qmd)
- FTS5 for keyword search (fast, always available)
- sqlite-vec for semantic search (requires embedding step)
- Separate index and embed steps (FTS5 is instant, embedding can be async)
- Model identifier stored in config (re-embed on change)
