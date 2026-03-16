import { Command } from "commander";
import type { ApiClient } from "../api-client.js";
import { isDaemonRunning, embeddedCallOp, getEmbeddedOrgId } from "../embedded.js";

export function commentCommands(client: ApiClient, getOrgId: () => string) {
  const cmd = new Command("comment").description("Document comments");

  async function callOp(opName: string, params: Record<string, any>) {
    if (await isDaemonRunning()) {
      return client.callOp(getOrgId(), opName, params);
    } else {
      const orgId = getEmbeddedOrgId();
      return embeddedCallOp(orgId, opName, params);
    }
  }

  cmd
    .command("add")
    .argument("<path>", "File path to comment on")
    .requiredOption("--body <text>", "Comment body")
    .option("--line <n>", "Line number (sets both line-start and line-end)")
    .option("--line-start <n>", "Start line")
    .option("--line-end <n>", "End line")
    .option("--quoted-content <text>", "Quoted content from the file")
    .description("Add a comment to a file")
    .action(async (path: string, opts: any) => {
      try {
        const params: Record<string, any> = { path, body: opts.body };
        if (opts.quotedContent) params.quotedContent = opts.quotedContent;
        if (opts.line) {
          params.lineStart = parseInt(opts.line);
          params.lineEnd = parseInt(opts.line);
        }
        if (opts.lineStart) params.lineStart = parseInt(opts.lineStart);
        if (opts.lineEnd) params.lineEnd = parseInt(opts.lineEnd);
        const result = await callOp("comment-add", params);
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("reply")
    .argument("<comment-id>", "Parent comment ID to reply to")
    .requiredOption("--body <text>", "Reply body")
    .description("Reply to a comment")
    .action(async (commentId: string, opts: any) => {
      try {
        const result = await callOp("comment-add", {
          parentId: commentId,
          body: opts.body,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .argument("[path]", "File path to list comments for")
    .option("--resolved", "Show resolved comments")
    .option("--limit <n>", "Max results")
    .option("--offset <n>", "Skip N results")
    .description("List comments")
    .action(async (path: string | undefined, opts: any) => {
      try {
        const params: Record<string, any> = {};
        if (path) params.path = path;
        if (opts.resolved) params.resolved = true;
        if (opts.limit) params.limit = parseInt(opts.limit);
        if (opts.offset) params.offset = parseInt(opts.offset);
        const result = await callOp("comment-list", params);
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("get")
    .argument("<id>", "Comment ID")
    .description("Get a comment with its replies")
    .action(async (id: string) => {
      try {
        const result = await callOp("comment-get", { id });
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("update")
    .argument("<id>", "Comment ID")
    .requiredOption("--body <text>", "New comment body")
    .description("Update a comment")
    .action(async (id: string, opts: any) => {
      try {
        const result = await callOp("comment-update", { id, body: opts.body });
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("delete")
    .argument("<id>", "Comment ID")
    .description("Delete a comment (soft delete)")
    .action(async (id: string) => {
      try {
        const result = await callOp("comment-delete", { id });
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("resolve")
    .argument("<id>", "Comment ID")
    .description("Resolve a comment")
    .action(async (id: string) => {
      try {
        const result = await callOp("comment-resolve", { id, resolved: true });
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("reopen")
    .argument("<id>", "Comment ID")
    .description("Reopen a resolved comment")
    .action(async (id: string) => {
      try {
        const result = await callOp("comment-resolve", { id, resolved: false });
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  return cmd;
}
