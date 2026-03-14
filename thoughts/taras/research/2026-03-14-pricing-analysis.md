---
date: 2026-03-14
author: Claude (research)
topic: "Pricing Analysis: agent-fs Hosted Service"
tags: [research, pricing, fly-io, tigris, agent-fs]
status: complete
---

# Pricing & Architecture Research: agent-fs Hosted Service

## Portless (vercel-labs/portless) — Daemon Inspiration

HTTP/WebSocket reverse proxy that replaces port numbers with `.localhost` URLs.

**Key patterns for agent-fs:**
- Auto-start daemon on first use (if proxy not running, transparently starts it)
- PID file + port detection to avoid duplicate daemons
- Internal health/status API (`/_register`, `/_routes`)
- Routes.json state file for persistence
- Foreground mode for debugging (`--foreground`)
- Graceful shutdown with connection drain

## Fly.io Cost Analysis

### Per-component pricing

| Component | Cost |
|---|---|
| shared-cpu-1x, 256MB (full-time) | $2.32/mo |
| shared-cpu-1x, 512MB (full-time) | ~$3.50/mo |
| shared-cpu-1x, 1GB (full-time) | ~$5.70/mo |
| Persistent volume | $0.15/GB/mo |
| Bandwidth (outbound) | $0.02/GB |
| **Tigris storage** | **$0.02/GB/mo** |
| Tigris PUT requests | $0.005/1K |
| Tigris GET requests | $0.0005/1K |
| **Tigris egress** | **$0 (free!)** |
| LiteFS | Free (open source) |

Scale-to-zero: stopped machines cost $0 for CPU/RAM.

### Per-org cost estimates (auto-stop ~30% utilization)

| Component | 1GB | 10GB | 100GB |
|---|---|---|---|
| Fly Machine | $1.05 | $1.05 | $1.75 |
| Persistent Volume | $0.15 | $0.30 | $1.50 |
| Tigris Storage | $0.02 | $0.20 | $2.00 |
| Tigris Requests | ~$0.05 | ~$0.10 | ~$0.30 |
| Bandwidth | $0.02 | $0.02 | $0.02 |
| Embeddings (amort/12mo) | $0.44 | $4.42 | $44.17 |
| **TOTAL/mo** | **~$1.73** | **~$6.09** | **~$49.74** |

Key insight: **Compute dominates low tiers. Embeddings dominate high tiers.** Storage is dirt cheap.

## Competitor Pricing

| Product | Free | Dev/Pro | Team | Enterprise |
|---|---|---|---|---|
| AgentMail | $0 (3 inboxes) | $20/mo (10) | $200/mo (10 pods) | Custom |
| Fast.io | $0 (50GB, 10K credits) | ~$12-38/mo | Custom | - |
| Turso | $0 (5GB, 100 DBs) | $5/mo (9GB) | $25/mo (24GB) | $417/mo |
| Supabase | $0 (1GB storage) | $25/mo (100GB) | $599/mo | Custom |

## Proposed agent-fs Pricing

| | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| **Price** | $0 | $19/mo | $99/mo | Custom |
| **Storage** | 1 GB | 10 GB | 100 GB | Unlimited |
| **Agents** | 3 | 20 | Unlimited | Unlimited |
| **Workspaces** | 1 | 5 | 25 | Unlimited |
| **Search queries** | 1K/mo | 50K/mo | Unlimited | Unlimited |
| **Versioning** | 7 days | 30 days | 90 days | Custom |
| **Rate limit** | 100 req/min | 1K/min | 10K/min | Custom |
| **Our cost** | ~$1.73 | ~$6.09 | ~$49.74 | Varies |
| **Gross margin** | Negative | ~68% | ~50% | High |

OSS self-hosted is always free. Hosted service competes on convenience.
