# Agent-fs live read-only search results

Date: 2026-09-15

## Scope and configuration

- CLI: `/Users/taras/.bun/bin/agent-fs`, version `0.13.4`.
- Saved config: `/Users/taras/.agent-fs/config.json`.
- Credential fields present: `apiKey` and `auth.apiKey`. Values were not read or printed.
- Saved endpoint: `https://agent-fs-taras.fly.dev`.
- Saved default context differs from the requested scope. Default `auth whoami` returned org `4dd6ec55-bdae-4b0d-86dc-dde960a2d01f` and drive `ec885d66-5350-4af8-a479-9808abaff93e`.
- Every request below set `AGENT_FS_API_URL=https://agent-fs-taras.fly.dev` and supplied `--org 648a5f3c-35c8-4f11-8673-b89de52cd6bd --drive 2faf73ba-4eee-4472-8b3b-359c4ed6bfbb`.
- Target evidence: `org current` returned target org `648a5f3c-35c8-4f11-8673-b89de52cd6bd`, named `swarm`. `drive current` returned target drive `2faf73ba-4eee-4472-8b3b-359c4ed6bfbb`, named `default`.

## Target file

Path: `thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-09-15-ai-tinkerers-demo-proposal.md`

- `stat`: success. `size=16021`, `contentType=text/markdown`, `isDeleted=false`, `createdAt=2026-09-15T18:29:24.446Z`, `modifiedAt=2026-09-15T15:59:24.000Z`.
- `cat --raw`: success. `totalLines=140`, `truncated=false`.
- The reported byte size and complete line read prove that the file exists and content was returned.

## Search matrix

| Mode and query | Exit | Count | Target proposal present | Result |
| --- | ---: | ---: | --- | --- |
| glob `ai-tinkerers` | 0 | 0 | No | Empty matches. |
| glob `**/*ai-tinkerers*` | 0 | 0 | No | Empty matches. |
| glob `*ai-tinkerers*` | 0 | 0 | No | Empty matches. |
| glob `**/*ai-tinkerers*`, `--path /thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research` | 0 | 2 | Yes | Both matching paths return with a leading slash. |
| glob `**/*ai-tinkerers*`, `--path thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research` | 0 | 2 | Yes | Identical results. Both matching paths return with a leading slash. |
| fts `ai-tinkerers` | 1 | n/a | n/a | Error: `no such column: tinkerers`. |
| fts `"ai tinkerers"` | 0 | 8 | Yes, rank 4 | Phrase query succeeds. |
| fts `ai tinkerers` | 0 | 9 | Yes, rank 4 | Spaced query succeeds. |
| fts `ai thinkerers` | 0 | 0 | No | Exact-token miss. CLI hint recommends `search`. |
| hybrid search `ai-tinkerers`, limit 5 | 0 | 5 | Yes, rank 4 | Successful target result. |
| hybrid search `ai thinkerers`, limit 5 | 0 | 5 | No | Five unrelated results. |
| vec-search `ai-tinkerers`, limit 5 | 0 | 5 | No | Related files rank, but target is not in top 5. |
| vec-search `ai thinkerers`, limit 5 | 0 | 5 | No | Five unrelated results. |

The scoped glob results were identical for both prefix forms:

```
/thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-09-15-ai-tinkerers-bcn-demo-night-recon.md
/thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-09-15-ai-tinkerers-demo-proposal.md
```

## Exact successful commands

```sh
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json org current
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json drive current
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json stat 'thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-09-15-ai-tinkerers-demo-proposal.md'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json cat --raw 'thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-09-15-ai-tinkerers-demo-proposal.md'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json glob 'ai-tinkerers'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json glob '**/*ai-tinkerers*'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json glob '*ai-tinkerers*'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json glob --path '/thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research' '**/*ai-tinkerers*'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json glob --path 'thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research' '**/*ai-tinkerers*'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json fts '"ai tinkerers"'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json fts 'ai tinkerers'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json fts 'ai thinkerers'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json search --limit 5 'ai-tinkerers'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json search --limit 5 'ai thinkerers'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json vec-search --limit 5 'ai-tinkerers'
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json vec-search --limit 5 'ai thinkerers'
```

## Failed command

```sh
AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' --json fts 'ai-tinkerers'
```

Exit code: `1`.

Error: `no such column: tinkerers`.

## Read-only guarantee

Only `whoami`, context inspection, `stat`, `cat`, `glob`, `fts`, `search`, and `vec-search` ran. No saved configuration changed. No production write, delete, move, copy, reindex, or browser action ran.
