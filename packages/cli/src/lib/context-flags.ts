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

/** The server answered 403 or 404 to a lookup. */
class Refused extends Error {}

/**
 * Turn the global `--org` and `--drive` values into ids.
 *
 * - Each flag takes an id or an exact name.
 * - `--drive` without `--org` also finds the org: the default org first,
 *   then the caller's other orgs.
 *
 * A drive is looked up among the drives the caller is on and those the
 * caller can manage: an org admin reaches a drive without being on it.
 *
 * A value that matches nothing passes through unchanged, so the server stays
 * the one that answers "not found". So does a value whose lookup the server
 * refuses with 403 or 404 (an org-scoped key cannot list orgs): the search
 * stops there and never moves on to another org. An ambiguous name throws,
 * and so does any other lookup failure.
 */
export async function resolveContextFlags(flags: ContextFlags, deps: Deps): Promise<ContextFlags> {
  const out: ContextFlags = { ...flags };
  try {
    if (flags.org && !UUID.test(flags.org)) {
      out.org = pick(await list(deps, "/orgs", "orgs"), flags.org, "Org") ?? flags.org;
    }
    if (flags.drive) Object.assign(out, await resolveDrive(flags.drive, out.org, deps));
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
  }
  return out;
}

async function resolveDrive(drive: string, org: string | undefined, deps: Deps): Promise<ContextFlags> {
  if (org) {
    return UUID.test(drive) ? {} : { drive: (await findDrive(deps, org, drive)) ?? drive };
  }

  const defaultOrg = await deps.defaultOrgId();
  if (defaultOrg) {
    const here = await findDrive(deps, defaultOrg, drive);
    if (here) return { drive: here };
  }

  const found: Array<{ org: Named; driveId: string }> = [];
  for (const candidate of await list(deps, "/orgs", "orgs")) {
    if (candidate.id === defaultOrg) continue;
    const driveId = await findDrive(deps, candidate.id, drive);
    if (driveId) found.push({ org: candidate, driveId });
  }
  if (found.length > 1) {
    const orgs = found.map((f) => `${f.org.name} (${f.org.id})`).join(", ");
    throw new Error(`Drive "${drive}" exists in several orgs: ${orgs}. Pass --org to choose one.`);
  }
  return found.length === 1 ? { org: found[0].org.id, drive: found[0].driveId } : {};
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
  const joined = await list(deps, path, "drives");
  if (joined.some((d) => d.id === ref)) return ref;
  const manageable = await list(deps, `${path}?scope=manageable`, "drives");
  const all = [...joined, ...manageable.filter((m) => !joined.some((j) => j.id === m.id))];
  return pick(all, ref, "Drive");
}

async function list(deps: Deps, path: string, key: "orgs" | "drives"): Promise<Named[]> {
  try {
    return (await deps.get(path))?.[key] ?? [];
  } catch (err: any) {
    if (err?.status === 403 || err?.status === 404) throw new Refused();
    throw err;
  }
}
