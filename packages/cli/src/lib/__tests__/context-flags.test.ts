import { describe, expect, test } from "bun:test";
import { resolveContextFlags } from "../context-flags.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const DRIVE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRIVE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ORGS: Org[] = [
  { id: ORG_A, name: "acme", drives: [{ id: DRIVE_A, name: "notes" }] },
  { id: ORG_B, name: "globex", drives: [{ id: DRIVE_B, name: "reports" }] },
];

type Org = { id: string; name: string; drives: Drive[]; manageable?: Drive[] };
type Drive = { id: string; name: string };

const failure = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function deps(
  orgs: Org[] = ORGS,
  defaultOrg: string | null = ORG_A,
  status: { orgs?: number; drives?: Record<string, number> } = {}
) {
  const calls: string[] = [];
  return {
    calls,
    get: async (path: string) => {
      calls.push(path);
      if (path === "/orgs") {
        if (status.orgs) throw failure(status.orgs);
        return { orgs: orgs.map(({ id, name }) => ({ id, name })) };
      }
      const [, orgId, scope] = /^\/orgs\/([^/]+)\/drives(\?scope=manageable)?$/.exec(path) ?? [];
      const org = orgs.find((o) => o.id === orgId);
      if (!org) throw failure(404);
      if (status.drives?.[org.id]) throw failure(status.drives[org.id]);
      return { drives: scope ? (org.manageable ?? org.drives) : org.drives };
    },
    defaultOrgId: async () => defaultOrg,
  };
}

describe("resolveContextFlags", () => {
  test("ids pass through without a lookup", async () => {
    const d = deps();
    expect(await resolveContextFlags({ org: ORG_B, drive: DRIVE_B }, d)).toEqual({ org: ORG_B, drive: DRIVE_B });
    expect(d.calls).toEqual([]);
  });

  test("org and drive names become ids", async () => {
    expect(await resolveContextFlags({ org: "globex", drive: "reports" }, deps())).toEqual({
      org: ORG_B,
      drive: DRIVE_B,
    });
  });

  test("an org name alone becomes an id", async () => {
    expect(await resolveContextFlags({ org: "globex" }, deps())).toEqual({ org: ORG_B });
  });

  test("a drive in the default org leaves --org unset", async () => {
    const d = deps();
    expect(await resolveContextFlags({ drive: "notes" }, d)).toEqual({ drive: DRIVE_A });
    expect(d.calls).toEqual([`/orgs/${ORG_A}/drives`]);
    expect(await resolveContextFlags({ drive: DRIVE_A }, deps())).toEqual({ drive: DRIVE_A });
  });

  test("a drive id from another org finds that org", async () => {
    expect(await resolveContextFlags({ drive: DRIVE_B }, deps())).toEqual({ org: ORG_B, drive: DRIVE_B });
  });

  test("a drive name from another org finds that org", async () => {
    expect(await resolveContextFlags({ drive: "reports" }, deps())).toEqual({ org: ORG_B, drive: DRIVE_B });
  });

  test("a drive is found with no default org", async () => {
    expect(await resolveContextFlags({ drive: DRIVE_B }, deps(ORGS, null))).toEqual({ org: ORG_B, drive: DRIVE_B });
  });

  test("the default org wins when the name exists there too", async () => {
    const orgs = [ORGS[0], { ...ORGS[1], drives: [{ id: DRIVE_B, name: "notes" }] }];
    expect(await resolveContextFlags({ drive: "notes" }, deps(orgs))).toEqual({ drive: DRIVE_A });
  });

  test("unknown values pass through for the server to answer", async () => {
    expect(await resolveContextFlags({ org: "nope", drive: "nope" }, deps())).toEqual({ org: "nope", drive: "nope" });
    expect(await resolveContextFlags({ drive: "nope" }, deps())).toEqual({ drive: "nope" });
  });

  test("a refused org list passes the values through", async () => {
    const d = deps(ORGS, ORG_A, { orgs: 403 });
    expect(await resolveContextFlags({ org: "globex" }, d)).toEqual({ org: "globex" });
    expect(await resolveContextFlags({ drive: DRIVE_B }, d)).toEqual({ drive: DRIVE_B });
  });

  test("a drive the caller manages in the default org wins over a same-named drive elsewhere", async () => {
    const orgs = [
      { id: ORG_A, name: "acme", drives: [], manageable: [{ id: DRIVE_A, name: "notes" }] },
      { id: ORG_B, name: "globex", drives: [{ id: DRIVE_B, name: "notes" }] },
    ];
    expect(await resolveContextFlags({ drive: "notes" }, deps(orgs))).toEqual({ drive: DRIVE_A });
  });

  test("a failed lookup in the default org is an error, not a search elsewhere", async () => {
    const orgs = [ORGS[0], { ...ORGS[1], drives: [{ id: DRIVE_B, name: "notes" }] }];
    const d = deps(orgs, ORG_A, { drives: { [ORG_A]: 500 } });
    await expect(resolveContextFlags({ drive: "notes" }, d)).rejects.toThrow("HTTP 500");
  });

  test("a failed org list is an error", async () => {
    await expect(resolveContextFlags({ org: "globex" }, deps(ORGS, ORG_A, { orgs: 500 }))).rejects.toThrow("HTTP 500");
  });

  test("a name shared by two drives of one org is an error", async () => {
    const orgs = [{ ...ORGS[0], drives: [{ id: DRIVE_A, name: "notes" }, { id: DRIVE_B, name: "notes" }] }];
    await expect(resolveContextFlags({ drive: "notes" }, deps(orgs))).rejects.toThrow(/ambiguous/);
  });

  test("a name shared by two orgs is an error", async () => {
    const orgs = [ORGS[0], { ...ORGS[1], name: "acme" }];
    await expect(resolveContextFlags({ org: "acme" }, deps(orgs))).rejects.toThrow(/ambiguous/);
  });

  test("a drive name found in several other orgs asks for --org", async () => {
    const orgs = [
      { id: ORG_A, name: "acme", drives: [{ id: DRIVE_A, name: "shared" }] },
      { id: ORG_B, name: "globex", drives: [{ id: DRIVE_B, name: "shared" }] },
    ];
    await expect(resolveContextFlags({ drive: "shared" }, deps(orgs, null))).rejects.toThrow(/Pass --org/);
  });
});
