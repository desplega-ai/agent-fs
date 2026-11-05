import { Command } from "commander";
import { WEBHOOK_EVENT_TYPES } from "@/core";
import type { ApiClient } from "../api-client.js";
import { outputResult } from "../formatters.js";
import { collect } from "./collect.js";

export type WebhookCliAction = "create" | "list" | "update" | "deliveries";

/** Commander's parsed options for `webhook create|list|update|deliveries`. */
export interface WebhookCliOpts {
  event?: string[];
  orgWide?: boolean;
  description?: string;
  pathPrefix?: string;
  scope?: string;
  url?: string;
  enable?: boolean;
  disable?: boolean;
  rotateSecret?: boolean;
  status?: string;
  limit?: string;
  cursor?: string;
  payload?: boolean;
}

const EVENT_LIST = WEBHOOK_EVENT_TYPES.join(", ");
const SECRET_NOTE =
  "Save the secret now: it is shown only this once. Receivers verify the webhook-signature header with it.";

/**
 * Map CLI flags to op params. `target` is the URL for `create` and the
 * webhook id for `update` and `deliveries`. Throws on a flag combination the op cannot take.
 * Event names are checked by the server.
 */
export function webhookParamsFromOpts(
  action: WebhookCliAction,
  opts: WebhookCliOpts,
  target?: string
): Record<string, unknown> {
  const events = opts.event ?? [];

  if (action === "list") {
    const scope = opts.scope ?? "all";
    if (!["drive", "org", "all"].includes(scope)) {
      throw new Error("--scope must be drive, org or all");
    }
    return { scope };
  }

  if (action === "create") {
    if (!target) throw new Error("Give the webhook URL");
    if (events.length === 0) {
      throw new Error(`Give at least one --event (${EVENT_LIST})`);
    }
    const params: Record<string, unknown> = {
      scope: opts.orgWide ? "org" : "drive",
      url: target,
      eventTypes: events,
    };
    if (opts.description !== undefined) params.description = opts.description;
    if (opts.pathPrefix !== undefined) params.pathPrefix = opts.pathPrefix;
    return params;
  }

  if (!target) throw new Error("Give the webhook id");

  if (action === "deliveries") {
    const params: Record<string, unknown> = { id: target };
    if (opts.status !== undefined) {
      if (!["pending", "delivered", "failed"].includes(opts.status)) {
        throw new Error("--status must be pending, delivered or failed");
      }
      params.status = opts.status;
    }
    if (opts.limit !== undefined) {
      if (!/^\d+$/.test(opts.limit)) throw new Error("--limit must be a positive integer");
      params.limit = Number(opts.limit);
    }
    if (opts.cursor !== undefined) params.cursor = opts.cursor;
    if (opts.payload) params.includePayload = true;
    return params;
  }

  if (opts.enable && opts.disable) {
    throw new Error("Use --enable or --disable, not both");
  }
  const params: Record<string, unknown> = { id: target };
  if (opts.url !== undefined) params.url = opts.url;
  if (events.length > 0) params.eventTypes = events;
  if (opts.description !== undefined) params.description = opts.description;
  if (opts.pathPrefix !== undefined) params.pathPrefix = opts.pathPrefix;
  if (opts.enable) params.enabled = true;
  if (opts.disable) params.enabled = false;
  if (opts.rotateSecret) params.rotateSecret = true;
  if (Object.keys(params).length === 1) {
    throw new Error(
      "Nothing to update: give --url, --event, --description, --path-prefix, --enable, --disable or --rotate-secret"
    );
  }
  return params;
}

export function webhookCommands(
  program: Command,
  client: ApiClient,
  getOrgId: () => string | Promise<string>,
  getDriveId: (orgId?: string) => string | Promise<string>
) {
  const cmd = new Command("webhook").description(
    "Outbound webhooks: signed HTTP POSTs for comment and file events (drive or org admin)"
  );

  async function callOp(opName: string, params: Record<string, unknown>) {
    try {
      const orgId = await getOrgId();
      const driveId = await getDriveId(orgId);
      return await client.callOp(orgId, opName, { ...params, driveId });
    } catch (err: any) {
      if (err?.cause?.code === "ECONNREFUSED" || err?.message?.includes("fetch failed")) {
        console.error(
          "Cannot connect to agent-fs daemon.\n" +
          "Start with: agent-fs daemon start\n" +
          "Or set AGENT_FS_API_URL to connect to a remote server."
        );
        process.exit(1);
      }
      throw err;
    }
  }

  async function run(opName: string, params: () => Record<string, unknown>) {
    try {
      const result: any = await callOp(opName, params());
      outputResult(opName, result, program.opts().json);
      if (typeof result?.secret === "string") console.error(SECRET_NOTE);
      if (result?.workerEnabled === false || result?.webhooks?.[0]?.workerEnabled === false) {
        console.error(
          "Note: this server does not deliver webhooks (AGENT_FS_WEBHOOK_WORKER is unset). Events queue until it is set."
        );
      }
      return result;
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  cmd
    .command("create")
    .argument("<url>", "Receiver URL (public https; redirects are not followed)")
    .option("--event <type>", `Event type to send (repeatable): ${EVENT_LIST}`, collect, [] as string[])
    .option("--org-wide", "Send events from every drive in the org (org admin only)")
    .option("--description <text>", "Note shown in webhook list")
    .option("--path-prefix <dir>", "Send file.changed only for paths under this directory (comment events are not filtered)")
    .description("Create a webhook for the active drive (or the whole org) and print its signing secret once")
    .action(async (url: string, opts: WebhookCliOpts) => {
      await run("webhook-create", () => webhookParamsFromOpts("create", opts, url));
    });

  cmd
    .command("list")
    .option("--scope <scope>", "drive, org or all (default: all you may manage)")
    .description("List webhooks of the active drive and org. Never shows secrets")
    .action(async (opts: WebhookCliOpts) => {
      await run("webhook-list", () => webhookParamsFromOpts("list", opts));
    });

  cmd
    .command("update")
    .argument("<id>", "Webhook ID")
    .option("--url <url>", "New receiver URL")
    .option("--event <type>", `Replace the event types (repeatable): ${EVENT_LIST}`, collect, [] as string[])
    .option("--description <text>", "New note; an empty string clears it")
    .option("--path-prefix <dir>", "New file.changed directory filter; an empty string or / clears it")
    .option("--enable", "Enable the webhook and reset its failure state")
    .option("--disable", "Disable the webhook; its queued deliveries are marked failed")
    .option("--rotate-secret", "Issue a new signing secret (printed once; the old one stops working at once)")
    .description("Change a webhook")
    .action(async (id: string, opts: WebhookCliOpts) => {
      await run("webhook-update", () => webhookParamsFromOpts("update", opts, id));
    });

  cmd
    .command("delete")
    .argument("<id>", "Webhook ID")
    .description("Delete a webhook and its queued deliveries")
    .action(async (id: string) => {
      await run("webhook-delete", () => ({ id }));
    });

  cmd
    .command("test")
    .argument("<id>", "Webhook ID")
    .description("Send a signed ping now and print the receiver's answer (exit 1 unless it answers 2xx)")
    .action(async (id: string) => {
      const result = await run("webhook-test", () => ({ id }));
      if (result?.ok !== true) process.exitCode = 1;
    });

  cmd
    .command("deliveries")
    .argument("<id>", "Webhook ID")
    .option("--status <status>", "Only pending, delivered or failed deliveries")
    .option("--limit <n>", "Page size (default 50, max 200)")
    .option("--cursor <cursor>", "nextCursor from the previous page")
    .option("--payload", "Include each delivery's exact JSON body")
    .description("List a webhook's deliveries, newest first (kept 30 days once delivered or failed)")
    .action(async (id: string, opts: WebhookCliOpts) => {
      await run("webhook-deliveries", () => webhookParamsFromOpts("deliveries", opts, id));
    });

  cmd
    .command("redeliver")
    .argument("<delivery-id>", "Delivery ID (from webhook deliveries)")
    .description("Send one delivery again now, same webhook-id and body (the webhook must be enabled)")
    .action(async (deliveryId: string) => {
      await run("webhook-redeliver", () => ({ deliveryId }));
    });

  return cmd;
}
