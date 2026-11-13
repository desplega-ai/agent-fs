import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Every GitHub Actions workflow pins its actions to a full commit SHA and
// declares the token permissions it needs. A tag or branch ref can move to
// different code without a change in this repo, and a workflow without a
// `permissions` key gets the repository default token, which is read/write
// here (RELEASING.md). npm-publish.yml already follows both rules.

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowsDir = resolve(__dirname, "../../../../.github/workflows");

type Workflow = {
  permissions?: unknown;
  jobs?: Record<string, { permissions?: unknown; uses?: string; steps?: { uses?: string }[] }>;
};

function workflowFiles(): string[] {
  return readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
}

function load(file: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(workflowsDir, file), "utf8")) as Workflow;
}

/** Every `uses:` ref in a workflow (job-level reusable workflows and steps). */
function usesRefs(wf: Workflow): string[] {
  const refs: string[] = [];
  for (const job of Object.values(wf.jobs ?? {})) {
    if (job.uses) refs.push(job.uses);
    for (const step of job.steps ?? []) if (step.uses) refs.push(step.uses);
  }
  return refs;
}

/** Remote refs not pinned to a 40-character commit SHA. Local and docker:// refs are exempt. */
function unpinned(refs: string[]): string[] {
  return refs.filter((ref) => {
    if (ref.startsWith("./") || ref.startsWith("docker://")) return false;
    const at = ref.lastIndexOf("@");
    return at === -1 || !/^[0-9a-f]{40}$/.test(ref.slice(at + 1));
  });
}

/** Jobs that inherit the default token: no workflow-level and no job-level `permissions`. */
function jobsWithDefaultToken(wf: Workflow): string[] {
  if (wf.permissions !== undefined) return [];
  return Object.entries(wf.jobs ?? {})
    .filter(([, job]) => job.permissions === undefined)
    .map(([name]) => name);
}

describe("workflow checker (control)", () => {
  test("flags tag and branch refs, accepts SHA, local and docker refs", () => {
    expect(
      unpinned([
        "actions/checkout@v4",
        "owner/repo/sub@main",
        "owner/repo",
        "actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332",
        "./.github/actions/local",
        "docker://alpine:3",
      ]),
    ).toEqual(["actions/checkout@v4", "owner/repo/sub@main", "owner/repo"]);
  });

  test("flags jobs without permissions only when the workflow sets none", () => {
    expect(jobsWithDefaultToken({ jobs: { a: {}, b: { permissions: {} } } })).toEqual(["a"]);
    expect(jobsWithDefaultToken({ permissions: {}, jobs: { a: {} } })).toEqual([]);
  });

  test("npm-publish.yml is pinned and scoped", () => {
    const wf = load("npm-publish.yml");
    expect(usesRefs(wf).length).toBeGreaterThan(0);
    expect(unpinned(usesRefs(wf))).toEqual([]);
    expect(jobsWithDefaultToken(wf)).toEqual([]);
  });
});

describe("GitHub workflows", () => {
  const files = workflowFiles();

  test("found workflow files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} pins every action to a commit SHA`, () => {
      expect(unpinned(usesRefs(load(file)))).toEqual([]);
    });

    test(`${file} declares token permissions for every job`, () => {
      expect(jobsWithDefaultToken(load(file))).toEqual([]);
    });
  }
});
