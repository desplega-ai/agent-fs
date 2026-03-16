#!/usr/bin/env bun
/**
 * Generate docs/openapi.json from the live op registry.
 * Usage: bun run scripts/sync-openapi.ts
 */
import { generateOpenAPISpec } from "../packages/core/src/openapi.js";
import { writeFileSync } from "fs";
import { resolve } from "path";

const spec = generateOpenAPISpec();
const json = JSON.stringify(spec, null, 2);
const outPath = resolve(import.meta.dirname!, "../docs/openapi.json");
writeFileSync(outPath, json + "\n");
console.log(`Wrote ${outPath}`);
