# Webhooks

agent-fs can send an HTTP POST to your URL when a comment or a file changes. A receiver can forward a mention to Slack, start an agent task, rebuild a site when a file lands, or log a review. Each request is signed with the [Standard Webhooks](https://www.standardwebhooks.com/) scheme, so you can check that it came from your agent-fs server.

## Quick start

```bash
# On the server: turn on delivery (see "Run the delivery worker")
export AGENT_FS_WEBHOOK_WORKER=true

# Create a webhook for the active drive. The secret is printed once: save it.
agent-fs webhook create https://hooks.example.com/agent-fs \
  --event comment.mentioned --event comment.created

# Send a signed ping and see what the receiver answered
agent-fs webhook test <webhook-id>
```

The same actions are ops on `POST /orgs/{orgId}/ops` and MCP tools: `webhook-create`, `webhook-list`, `webhook-update`, `webhook-delete`, `webhook-test`, `webhook-deliveries` and `webhook-redeliver`. See the [OpenAPI spec](./openapi.json) for their params.

| Command | What it does |
|---------|--------------|
| `agent-fs webhook create <url> --event <type>... [--org-wide] [--description <text>] [--path-prefix <dir>]` | Create a webhook. Prints it with its `whsec_` secret, once. |
| `agent-fs webhook list [--scope drive\|org\|all]` | List the webhooks you may manage. Secrets are never shown. |
| `agent-fs webhook update <id> [--url <url>] [--event <type>]... [--description <text>] [--path-prefix <dir>] [--enable\|--disable] [--rotate-secret]` | Change a webhook. `--event` replaces the whole list. An empty `--path-prefix` clears it. |
| `agent-fs webhook delete <id>` | Delete a webhook and all its deliveries. |
| `agent-fs webhook test <id>` | Send a signed `ping` now. Exits 1 unless the receiver answers 2xx. |
| `agent-fs webhook deliveries <id> [--status pending\|delivered\|failed] [--limit <n>] [--cursor <cursor>] [--payload]` | List the webhook's deliveries, newest first. |
| `agent-fs webhook redeliver <delivery-id>` | Send one delivery again now. |

## Drive and org webhooks

- A **drive webhook** (the default) gets events from one drive. A drive admin or an org admin can manage it.
- An **org webhook** (`--org-wide`, or `scope: "org"`) gets events from every drive in the org. Only an org admin can manage it. Org admins can already open every drive in their org, so an org webhook shows them nothing new.
- An org has at most 25 webhooks, drive and org webhooks together.

Every webhook command runs against a drive: the active drive, or the one you pass with `--drive`. You must be a member of that drive. A drive webhook is visible only from its own drive. An org webhook is visible from any drive in the org. Any other id returns `404`, the same as an id that does not exist.

## Events

| Type | Sent when |
|------|-----------|
| `comment.created` | A comment or a reply is added. |
| `comment.mentioned` | A user is mentioned with the `mentions` param (CLI: `--mention`). One event per mentioned user. It is sent on `comment-add`, and on `comment-update` for users the update newly adds. |
| `comment.updated` | A comment is edited. |
| `comment.resolved` | A comment is resolved. |
| `comment.reopened` | A resolved comment is reopened. |
| `comment.deleted` | A comment is deleted. Deleting a root comment also deletes its replies, but sends one event, for the root. |
| `file.changed` | A file gets a new version: a write, edit, append, revert, copy or delete, including writes through a FUSE mount. A move sends two: a `write` for the new path and a `delete` for the old one. A write with the same bytes as the current version makes no version and sends nothing. |
| `ping` | Only `webhook test` sends it. You cannot subscribe to it. |

Only the `mentions` param mentions someone. Typing `@name` in the comment body does not send `comment.mentioned`. Only drive members can be mentioned. Mentioning yourself, or removing a mention, sends nothing.

A webhook gets only the types it lists. `file.changed` is never implied: a webhook created before it existed, or one that lists only comment types, gets no file events. Add it with `--event file.changed` (or `eventTypes` on `webhook-update`, which replaces the whole list).

### Limit file events to a directory

Set `--path-prefix /docs/` (or `pathPrefix` on `webhook-create` and `webhook-update`) to get `file.changed` only for paths under that directory. `/docs/` matches `/docs/a.md` and `/docs/specs/b.md`, not `/docs.md` or `/docsite/x.md`. A missing leading or trailing `/` is added, so `docs` is stored as `/docs/`. `/`, or an empty value on update, removes the filter. A prefix with a `.` or `..` segment is refused. The prefix filters `file.changed` only; comment events are not filtered by it.

One change can send several events. A new comment that mentions two users sends one `comment.created` and two `comment.mentioned`, each with its own `webhook-id`.

agent-fs writes the deliveries in the same database transaction as the comment change or the new file version. If the change is saved, its events will be sent. If the change fails, nothing is sent. A webhook gets only events that happen while it is enabled.

## Payload

The body is JSON. It is built once when the event happens, so every retry sends the same bytes.

```json
{
  "type": "comment.mentioned",
  "timestamp": "2026-11-05T10:15:00.000Z",
  "data": {
    "eventId": "3f0c9a1e-…",
    "orgId": "…",
    "driveId": "…",
    "path": "/docs/plan.md",
    "url": "https://app.example.com/file/~/<org>/<drive>/docs/plan.md",
    "actor": { "id": "…", "email": "ana@example.com", "displayName": "Ana" },
    "comment": {
      "id": "…",
      "parentId": "…",
      "body": "@Ben can you check the numbers?",
      "bodyTruncated": false,
      "quote": { "exact": "Q3 revenue", "prefix": null, "suffix": null },
      "lineStart": 3,
      "lineEnd": 4,
      "resolved": false,
      "createdAt": "2026-11-05T10:15:00.000Z",
      "updatedAt": "2026-11-05T10:15:00.000Z",
      "author": { "id": "…", "email": "ana@example.com", "displayName": "Ana" },
      "mentions": [{ "id": "…", "email": "ben@example.com", "displayName": "Ben" }]
    },
    "mentioned": { "id": "…", "email": "ben@example.com", "displayName": "Ben" },
    "thread": {
      "rootId": "…",
      "participants": [{ "id": "…", "email": "cy@example.com", "displayName": "Cy" }]
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `type` | The event type. |
| `timestamp` | When the event happened (ISO 8601). Retries keep it. |
| `data.eventId` | The event id. It equals the `webhook-id` header. |
| `data.orgId`, `data.driveId`, `data.path` | Where the comment is. |
| `data.url` | A link to the file in the web app. Present only when the server sets `AGENT_FS_APP_URL`. |
| `data.actor` | The user who made the change. For a resolve or a delete this is often not the author. |
| `data.comment` | The comment after the change. `comment.deleted` carries the comment as it was before the delete. |
| `data.comment.body` | Cut at 8,000 characters. `bodyTruncated` is `true` when it was cut. |
| `data.comment.quote` | The text the comment is anchored to, or `null`. |
| `data.comment.mentions` | Everyone the comment mentions now. |
| `data.mentioned` | Only on `comment.mentioned`: the user this event is for. |
| `data.thread` | Only on replies. `rootId` is the root comment. `participants` are the root author and the authors of the replies that are not deleted, without the actor, in the order they first posted. |

A field with no value is `null`. Only `url`, `mentioned` and `thread` are left out when they do not apply.

### `file.changed` payload

```json
{
  "type": "file.changed",
  "timestamp": "2026-11-05T10:15:00.000Z",
  "data": {
    "eventId": "9b2d7c4e-…",
    "orgId": "…",
    "driveId": "…",
    "path": "/docs/plan.md",
    "url": "https://app.example.com/file/~/<org>/<drive>/docs/plan.md",
    "version": 4,
    "operation": "edit",
    "author": { "id": "…", "email": "ana@example.com", "displayName": "Ana" },
    "size": 1832,
    "etag": "\"5d41402abc4b2a76b9719d911017c592\""
  }
}
```

| Field | Meaning |
|-------|---------|
| `data.path`, `data.version` | The file and the version this change made. Read it with `agent-fs cat <path>` or `log`. |
| `data.operation` | `write`, `edit`, `append`, `revert` or `delete`. A copy and the new path of a move are `write`. |
| `data.author` | The user who made the version. |
| `data.size`, `data.etag` | Size in bytes and storage etag of the new version. Both are `null` for a `delete`. |

The payload never carries file content. Fetch the file if you need it. Each version has its own `eventId`; an org webhook and a drive webhook that both match get the same one.

The `ping` that `webhook test` sends looks like this, with a `webhook-id` of the form `ping_<uuid>`:

```json
{ "type": "ping", "timestamp": "…", "data": { "subscriptionId": "…", "orgId": "…", "driveId": "…" } }
```

`driveId` is `null` for an org webhook.

## Headers

| Header | Value |
|--------|-------|
| `content-type` | `application/json` |
| `user-agent` | `agent-fs-webhooks/<server version>` |
| `webhook-id` | The event id. It stays the same on every retry. |
| `webhook-timestamp` | Unix seconds when this attempt was sent. It changes on each retry. |
| `webhook-signature` | `v1,<base64 signature>` |

## Verify the signature

The signature is HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<raw body>`. The key is the part of the secret after `whsec_`, base64-decoded. Always verify the raw body bytes, before you parse the JSON. Refuse a `webhook-timestamp` that is more than 5 minutes from your clock; the libraries below do this for you.

With the [`standardwebhooks`](https://www.npmjs.com/package/standardwebhooks) npm package:

```ts
import { Webhook } from "standardwebhooks";

// The whsec_… secret printed by `agent-fs webhook create`.
const wh = new Webhook(process.env.AGENT_FS_WEBHOOK_SECRET!);

Bun.serve({
  port: 8080,
  async fetch(req) {
    const body = await req.text();
    const headers = Object.fromEntries(req.headers);
    let event;
    try {
      event = wh.verify(body, headers); // throws when the signature or timestamp is wrong
    } catch {
      return new Response("invalid signature", { status: 401 });
    }

    // Deliveries can repeat: skip a webhook-id you have already handled.
    console.log(headers["webhook-id"], event.type, event.data.path);
    return new Response(null, { status: 204 });
  },
});
```

The same package exists for Python, Go, Rust, Ruby, PHP, Java and C#; see [standardwebhooks.com](https://www.standardwebhooks.com/).

An [agent-swarm](https://github.com/desplega-ai/agent-swarm) webhook trigger can verify these requests itself. Store the `whsec_…` secret as a swarm secret and set the trigger's verification format:

```json
{
  "type": "webhook",
  "hmacSecret": "secret.AGENT_FS_WEBHOOK_SECRET",
  "verification": { "format": "standard-webhooks" }
}
```

## Delivery

- **At least once.** The same event can arrive more than once, for example after a timeout or a server crash. Use `webhook-id` to drop repeats.
- **One id per event.** When several webhooks get the same event, each request carries the same `webhook-id`.
- **No order.** Events can arrive out of order, more so after retries. Use `timestamp` to order them.
- **Answer fast.** Return a 2xx within 15 seconds. Do slow work after you answer.
- **Redirects are not followed.** A 3xx answer counts as a failure, and the error names the redirect target's host. Point the webhook at the final URL, including any trailing slash.

### Retries

A failure is any answer other than 2xx, a timeout, a network error, or a URL the server refuses to call (see [URL rules](#url-rules)). A failed delivery is tried again after 5 s, 5 min, 30 min, 2 h, 5 h, 10 h and 10 h, each with up to 20% jitter. That is 8 attempts over about 28 hours. After the last one the delivery is marked failed.

### Automatic disable

- **410 Gone.** A `410` answer disables the webhook at once (`disabledReason: "gone"`). Answer `410` when your receiver no longer wants events.
- **5 days of failures.** A webhook whose deliveries keep failing for 5 days with no success in between is disabled (`disabledReason: "failing"`).

When a webhook is disabled, for any reason, its queued deliveries are marked failed, and new events are not queued for it. `agent-fs webhook update <id> --enable` turns it back on and resets its failure state. Events from the time it was disabled are not sent. Deliveries it failed can be sent again with [`webhook redeliver`](#delivery-log).

`webhook list` shows the state of each webhook: `enabled`, `disabledReason`, `disabledAt`, `consecutiveFailures`, `lastSuccessAt` and `lastFailureAt`.

### Restarts

Deliveries are stored in the database, so a restart loses none. Stopping the server cuts the sends in progress, and the next start sends them again at once, with the same `webhook-id`. If the process crashes during a send, the delivery is sent again about a minute later. A cut or crashed attempt still counts toward the 8.

### Delivery log

`agent-fs webhook deliveries <id>` lists a webhook's deliveries, newest first, 50 per page (`--limit` up to 200):

```json
{
  "deliveries": [
    {
      "id": "…", "subscriptionId": "…", "eventId": "…", "eventType": "comment.mentioned",
      "status": "failed", "attempts": 8, "nextAttemptAt": null,
      "lastAttemptAt": "…", "lastStatusCode": 503, "lastError": "HTTP 503: …",
      "deliveredAt": null, "createdAt": "…"
    }
  ],
  "nextCursor": "…"
}
```

- `status` is `pending` (queued or waiting for a retry, due at `nextAttemptAt`), `delivered` or `failed`. `--status` filters on it.
- `eventId` is the `webhook-id` the receiver got.
- `--payload` adds `payload`, the exact JSON body that was signed and sent.
- When `nextCursor` is not `null`, pass it as `--cursor` for the next page.

`agent-fs webhook redeliver <delivery-id>` queues one delivery to be sent again now, with the same `webhook-id` and body. It works on a delivered, failed or pending delivery. The attempt count is kept, so a delivery that already used its 8 attempts gets one more try and no further retries. Redelivery is refused while the webhook is disabled (enable it first) and while the delivery is being sent. The delivery worker sends it.

Delivered and failed deliveries are deleted 30 days after they were created. Pending ones are kept until they are sent or fail. The delivery worker prunes once an hour.

Both ops need the same role as the webhook: drive or org admin for a drive webhook, org admin for an org webhook.

## Test a webhook

`agent-fs webhook test <id>` sends a signed `ping` right away and prints the result:

```json
{ "ok": true, "statusCode": 204, "durationMs": 87, "webhookId": "ping_…" }
```

On a failure, `ok` is `false` and `error` says why. The test works when the delivery worker is off and when the webhook is disabled. It does not change the failure counters and is not retried. Use it to check a new receiver before real events arrive.

## URL rules

The server checks the URL when you create or update a webhook, and again before every send, because DNS can change.

- The URL must be `https://`. Plain `http://` works only for an allowed host, or with `AGENT_FS_WEBHOOK_ALLOW_PRIVATE=true` (below).
- It must not contain a username or password, and must be at most 2,048 characters.
- The server resolves the host name. It refuses the URL if any address is private, loopback, link-local (this includes cloud metadata addresses such as `169.254.169.254`) or otherwise not public. IPv6 addresses that carry an IPv4 address (IPv4-mapped, NAT64 and 6to4) are checked by that IPv4 address. Teredo (`2001::/32`) and SIIT (`::ffff:0:a.b.c.d`) addresses are always refused. The request then connects to the address that was checked.

To reach a receiver on a private network, such as a service in the same Docker Compose project, list it on the server:

```bash
AGENT_FS_WEBHOOK_ALLOWED_HOSTS=receiver:8080,*.internal.example.com
```

Entries are comma-separated `host[:port]` patterns. A leading `*.` matches subdomains. An entry without a port matches every port. A listed host may be private and may use `http://`. Public hosts stay reachable. An invalid value makes `webhook create` fail, and a server with the delivery worker on refuses to start.

`AGENT_FS_WEBHOOK_ALLOW_PRIVATE=true` allows every private address and plain `http://`. Use it only when every service the server can reach is trusted.

## Run the delivery worker

Delivery is off by default. Set `AGENT_FS_WEBHOOK_WORKER=true` (or `1`) on the server, on exactly one process per database.

Without it, you can still create, list and test webhooks, and events are still queued. Nothing is sent until a server starts with the flag. Webhook responses carry `workerEnabled: false`, and when enabled webhooks exist the server logs a warning at startup.

The worker checks for due deliveries every 2 seconds, and right after a comment change queues one. It sends up to 10 at a time. A server that supports webhooks lists `webhooks` in the `/health` `features` array.

## Signing secrets

- The secret is shown once: in the `webhook create` response, and in the `webhook update --rotate-secret` response. Store it in your receiver's secret store.
- `webhook update <id> --rotate-secret` issues a new secret. The old one stops working at once; there is no grace period. Deliveries are signed when they are sent, so queued deliveries use the new secret. To switch without failed checks, let your receiver accept both secrets until it has the new one.

The server stores each secret encrypted with AES-256-GCM. It reads the encryption key from, in order:

1. `AGENT_FS_SECRETS_KEY`: a base64 string of 32 bytes (`openssl rand -base64 32`).
2. `AGENT_FS_SECRETS_KEY_FILE`: the path of a file that holds such a string.
3. `$AGENT_FS_HOME/.secrets-key`: created with mode `0600` by the first `webhook create` when neither variable is set.

Back the key up with the database. Without it the server cannot sign deliveries: they wait and are retried every minute, without using an attempt or counting toward auto-disable. The server also refuses to create a new key while webhooks exist. If the key is lost, set a new one with `AGENT_FS_SECRETS_KEY` and rotate the secret of every webhook.
