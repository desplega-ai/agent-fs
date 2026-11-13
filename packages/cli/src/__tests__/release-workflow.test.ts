import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

// Shape checks for the release workflow that publishes this package.
// Jobs that only build or test get a read-only token; the publish jobs get
// exactly the extra scopes they use, and every job after `validate` builds
// the commit `validate` tested.

type Permissions = Record<string, string> | "read-all" | "write-all" | undefined;
type Step = { uses?: string; with?: Record<string, unknown>; run?: string };
type Job = { permissions?: Permissions; steps?: Step[]; outputs?: Record<string, string> };
type Workflow = { permissions?: Permissions; jobs: Record<string, Job> };

const WORKFLOW_PATH = join(import.meta.dir, "../../../../.github/workflows/npm-publish.yml");
const workflow = YAML.parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;

// A job-level `permissions` block replaces the workflow-level one entirely.
function effectivePermissions(wf: Workflow, jobName: string): Record<string, string> {
  const perms = wf.jobs[jobName]?.permissions ?? wf.permissions;
  if (perms === "write-all") return { contents: "write", "id-token": "write", "*": "write" };
  if (perms === "read-all") return { contents: "read", "*": "read" };
  // No block anywhere falls back to the repository default, which may be write.
  if (perms === undefined) return { contents: "write", "*": "write" };
  return perms;
}

function grants(perms: Record<string, string>, scope: string, level: "write"): boolean {
  return perms[scope] === level || perms["*"] === level;
}

function checkouts(job: Job): Step[] {
  return (job.steps ?? []).filter((s) => s.uses?.startsWith("actions/checkout@"));
}

const BUILD_ONLY_JOBS = ["validate", "build-fuse", "build-manifest"];
const PUBLISH_JOBS = ["publish-fuse-subpackages", "publish-main"];

describe("release workflow", () => {
  test("control: workflow parses and has the expected jobs", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(
      [...BUILD_ONLY_JOBS, ...PUBLISH_JOBS].sort(),
    );
    for (const name of Object.keys(workflow.jobs)) {
      expect(checkouts(workflow.jobs[name]!).length).toBe(1);
    }
    // publish-main signs provenance and creates the GitHub release.
    const main = effectivePermissions(workflow, "publish-main");
    expect(grants(main, "id-token", "write")).toBe(true);
    expect(grants(main, "contents", "write")).toBe(true);
  });

  test("control: job-level permissions replace the workflow-level block", () => {
    const wf: Workflow = {
      permissions: { contents: "write" },
      jobs: { a: { permissions: { contents: "read" } }, b: {} },
    };
    expect(grants(effectivePermissions(wf, "a"), "contents", "write")).toBe(false);
    expect(grants(effectivePermissions(wf, "b"), "contents", "write")).toBe(true);
  });

  test("workflow-level permissions are read-only", () => {
    const perms = workflow.permissions;
    expect(typeof perms).toBe("object");
    for (const [scope, level] of Object.entries(perms as Record<string, string>)) {
      expect({ scope, level }).toEqual({ scope, level: level === "write" ? "read" : level });
    }
  });

  test("build and test jobs hold no write scopes", () => {
    for (const name of BUILD_ONLY_JOBS) {
      const perms = effectivePermissions(workflow, name);
      expect({ job: name, contents: grants(perms, "contents", "write") }).toEqual({
        job: name,
        contents: false,
      });
      expect({ job: name, idToken: grants(perms, "id-token", "write") }).toEqual({
        job: name,
        idToken: false,
      });
    }
  });

  test("only publish-main can write repository contents", () => {
    const fuse = effectivePermissions(workflow, "publish-fuse-subpackages");
    expect(grants(fuse, "contents", "write")).toBe(false);
    expect(grants(fuse, "id-token", "write")).toBe(true);
  });

  test("no checkout persists the job token", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of checkouts(job)) {
        expect({ job: name, persist: step.with?.["persist-credentials"] }).toEqual({
          job: name,
          persist: false,
        });
      }
    }
  });

  test("jobs after validate check out the commit validate tested", () => {
    const sha = workflow.jobs.validate?.outputs?.release_sha;
    expect(sha).toBeDefined();
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === "validate") continue;
      for (const step of checkouts(job)) {
        expect({ job: name, ref: step.with?.ref }).toEqual({
          job: name,
          ref: "${{ needs.validate.outputs.release_sha }}",
        });
      }
    }
  });
});
