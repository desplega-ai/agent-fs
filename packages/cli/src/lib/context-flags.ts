export interface ContextFlags {
  org?: string;
  drive?: string;
}

interface Deps {
  /** GET against the API; rejects on a non-2xx answer. */
  get: (path: string) => Promise<any>;
  /** The org used when `--org` is absent (config, env, account default). */
  defaultOrgId: () => Promise<string | null>;
}

type Named = { id: string; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn the global `--org` and `--drive` values into ids.
 *
 * - Each flag takes an id or an exact name.
 * - `--drive` without `--org` also finds the org: the default org first,
 *   then the caller's other orgs.
 *
 * A value that matches nothing, or a lookup the server refuses (an
 * org-scoped key cannot list orgs), passes through unchanged, so the server
 * stays the one that answers "not found". Only an ambiguous name throws.
 */
export async function resolveContextFlags(flags: ContextFlags, deps: Deps): Promise<ContextFlags> {
  const out: ContextFlags = { ...flags };

  if (flags.org && !UUID.test(flags.org)) {
    out.org = pick(await listOrgs(deps), flags.org, "Org") ?? flags.org;
  }
  if (!flags.drive) return out;

  if (out.org) {
    if (!UUID.test(flags.drive)) {
      out.drive = pick(await listDrives(deps, out.org), flags.drive, "Drive") ?? flags.drive;
    }
    return out;
  }

  const defaultOrg = await deps.defaultOrgId();
  if (defaultOrg) {
    const here = pick(await listDrives(deps, defaultOrg), flags.drive, "Drive");
    if (here) {
      out.drive = here;
      return out;
    }
  }

  const found: Array<{ org: Named; driveId: string }> = [];
  for (const org of await listOrgs(deps)) {
    if (org.id === defaultOrg) continue;
    const driveId = pick(await listDrives(deps, org.id), flags.drive, "Drive");
    if (driveId) found.push({ org, driveId });
  }
  if (found.length > 1) {
    const orgs = found.map((f) => `${f.org.name} (${f.org.id})`).join(", ");
    throw new Error(`Drive "${flags.drive}" exists in several orgs: ${orgs}. Pass --org to choose one.`);
  }
  if (found.length === 1) {
    out.org = found[0].org.id;
    out.drive = found[0].driveId;
  }
  return out;
}

function pick(items: Named[], ref: string, kind: "Org" | "Drive"): string | undefined {
  const byId = items.find((i) => i.id === ref);
  if (byId) return byId.id;
  const byName = items.filter((i) => i.name === ref);
  if (byName.length > 1) {
    const ids = byName.map((i) => i.id).join(", ");
    throw new Error(`${kind} name "${ref}" is ambiguous (${ids}). Use the id.`);
  }
  return byName[0]?.id;
}

async function listOrgs(deps: Deps): Promise<Named[]> {
  return (await deps.get("/orgs").catch(() => null))?.orgs ?? [];
}

async function listDrives(deps: Deps, orgId: string): Promise<Named[]> {
  return (await deps.get(`/orgs/${encodeURIComponent(orgId)}/drives`).catch(() => null))?.drives ?? [];
}
