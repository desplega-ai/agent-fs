#!/usr/bin/env bun
// wts setup script - runs after worktree creation
//
// Environment variables:
//   WTS_WORKTREE_PATH - path to the new worktree (also the working directory)
//   WTS_GIT_ROOT      - path to the main repository root

import { existsSync } from "fs";
import { join } from "path";

const worktreePath = process.env.WTS_WORKTREE_PATH!;
const gitRoot = process.env.WTS_GIT_ROOT!;

console.log(`Setting up worktree at ${worktreePath}...`);

// Install dependencies
await Bun.$`bun install`;

// Copy Claude Code config
const mcpJson = join(gitRoot, ".mcp.json");
if (existsSync(mcpJson)) {
  await Bun.$`cp ${mcpJson} .mcp.json`;
  console.log("Copied .mcp.json");
}

const claudeDir = join(gitRoot, ".claude");
if (existsSync(claudeDir)) {
  await Bun.$`cp -r ${claudeDir} .claude`;
  console.log("Copied .claude/");
}

console.log("Setup complete!");
