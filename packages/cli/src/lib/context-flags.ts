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
 * A drive is looked up among the drives the caller is on, then among those
 * the caller can manage: an org admin reaches a drive without being on it.
 *
 * A value that matches nothing, or a lookup the server refuses with 403 or
 * 404 (an org-scoped key cannot list orgs), passes through unchanged, so the
 * server stays the one that answers "not found". An ambiguous name throws,
 * and so does any other lookup failure: guessing another org after a failed
 * lookup could send a write to the wrong place.
 */
export async function resolveContextFlags(flags: ContextFlags, deps: Deps): Promise<ContextFlags> {
  const out: ContextFlags = { ...flags };

  if (flags.org && !UUID.test(flags.org)) {
    out.org = pick(await listOrgs(deps), flags.org, "Org") ?? flags.org;
  }
  if (!flags.drive) return out;

  if (out.org) {
    if (!UUID.test(flags.drive)) {
      out.drive = (await findDrive(deps, out.org, flags.drive)) ?? flags.drive;
    }
    return out;
  }

  const defaultOrg = await deps.defaultOrgId();
  if (defaultOrg) {
    const here = await findDrive(deps, defaultOrg, flags.drive);
    if (here) {
      out.drive = here;
      return out;
    }
  }

  const found: Array<{ org: Named; driveId: string }> = [];
  for (const org of await listOrgs(deps)) {
    if (org.id === defaultOrg) continue;
    const driveId = await findDrive(deps, org.id, flags.drive);
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

async function findDrive(deps: Deps, orgId: string, ref: string): Promise<string | undefined> {
  const path = `/orgs/${encodeURIComponent(orgId)}/drives`;
  return (
    pick(await list(deps, path, "drives"), ref, "Drive") ??
    pick(await list(deps, `${path}?scope=manageable`, "drives"), ref, "Drive")
  );
}

function listOrgs(deps: Deps): Promise<Named[]> {
  return list(deps, "/orgs", "orgs");
}

async function list(deps: Deps, path: string, key: "orgs" | "drives"): Promise<Named[]> {
  try {
    return (await deps.get(path))?.[key] ?? [];
  } catch (err: any) {
    if (err?.status === 403 || err?.status === 404) return [];
    throw err;
  }
}
