import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../errors.js";
import { assertWebhookUrl, webhookEgressConfig, webhookFetch } from "../egress.js";
import { EgressDeniedError, isPrivateAddress } from "../egress-guard.js";

// DNS is injected: names resolve through this table, nothing leaves the box.
const DNS: Record<string, string[]> = {
  "hooks.example.com": ["93.184.216.34"],
  "rebind.example.com": ["10.1.2.3"],
  "mixed.example.com": ["93.184.216.34", "192.168.1.10"],
  receiver: ["172.18.0.2"],
  "v6.example.com": ["2606:4700:4700::1111"],
  "teredo.example.com": ["2001:0:4136:e378:8000:63bf:3fff:fdd2"],
  "siit.example.com": ["::ffff:0:8.8.8.8"],
};

// Teredo (2001::/32) tunnels to an IPv4 client; SIIT (::ffff:0:a.b.c.d,
// RFC 2765) is translated to an IPv4. Both are refused whatever they embed.
const TEREDO = "2001:0:4136:e378:8000:63bf:3fff:fdd2";
const SIIT_PUBLIC = "::ffff:0:8.8.8.8";
const SIIT_LOOPBACK = "::ffff:0:127.0.0.1";
const resolve = async (host: string): Promise<string[]> => {
  const answer = DNS[host];
  if (!answer) throw new Error(`ENOTFOUND ${host}`);
  return answer;
};

async function refusal(url: string, env: NodeJS.ProcessEnv = {}): Promise<ValidationError> {
  try {
    await assertWebhookUrl(url, { env, resolve });
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe("url");
    return err as ValidationError;
  }
  throw new Error(`expected ${url} to be refused`);
}

describe("assertWebhookUrl", () => {
  test.each([
    "http://127.0.0.1/hook",
    "https://127.0.0.1/hook",
    "http://[::1]/hook",
    "https://[::1]/hook",
    "http://169.254.169.254/latest/meta-data",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/hook",
    "https://localhost/hook",
    "https://[::ffff:10.0.0.5]/hook",
  ])("refuses private or loopback target %s", async (url) => {
    await refusal(url);
  });

  test("refuses a public name that resolves to a private address", async () => {
    const err = await refusal("https://rebind.example.com/hook");
    expect(err.message).toContain("Webhook egress refused");
    expect(err.message).toContain("AGENT_FS_WEBHOOK_ALLOWED_HOSTS");
  });

  test("refuses a name whose answers mix public and private addresses", async () => {
    await refusal("https://mixed.example.com/hook");
  });

  test("refuses a name that does not resolve", async () => {
    const err = await refusal("https://nope.example.com/hook");
    expect(err.message).toContain("could not resolve");
  });

  test("allows a public https URL", async () => {
    const url = await assertWebhookUrl("https://hooks.example.com/af", { env: {}, resolve });
    expect(url.href).toBe("https://hooks.example.com/af");
  });

  test("refuses plain http to a public host unless allowlisted", async () => {
    const err = await refusal("http://hooks.example.com/af");
    expect(err.message).toContain("https://");
    await assertWebhookUrl("http://hooks.example.com/af", {
      env: { AGENT_FS_WEBHOOK_ALLOWED_HOSTS: "hooks.example.com" },
      resolve,
    });
  });

  test("allows http://receiver:8080 only when it is allowlisted", async () => {
    await refusal("http://receiver:8080/hook");
    const env = { AGENT_FS_WEBHOOK_ALLOWED_HOSTS: "receiver:8080" };
    await assertWebhookUrl("http://receiver:8080/hook", { env, resolve });
    // The port is part of the entry.
    await refusal("http://receiver:9090/hook", env);
    // The allowlist is additive: public hosts still work, private ones still do not.
    await assertWebhookUrl("https://hooks.example.com/af", { env, resolve });
    await refusal("https://10.0.0.5/hook", env);
  });

  test("a wildcard entry covers subdomains", async () => {
    const env = { AGENT_FS_WEBHOOK_ALLOWED_HOSTS: "*.internal" };
    await assertWebhookUrl("http://hooks.svc.internal/x", { env, resolve });
    await refusal("http://internal/x", env);
  });

  test("AGENT_FS_WEBHOOK_ALLOW_PRIVATE=true allows private targets", async () => {
    const env = { AGENT_FS_WEBHOOK_ALLOW_PRIVATE: "true" };
    await assertWebhookUrl("https://10.0.0.5/hook", { env, resolve });
    await assertWebhookUrl("https://rebind.example.com/hook", { env, resolve });
    await assertWebhookUrl("http://127.0.0.1:9000/hook", { env, resolve });
  });

  test("refuses userinfo", async () => {
    const err = await refusal("https://user:pass@hooks.example.com/af");
    expect(err.message).toContain("username or password");
    await refusal("https://user@hooks.example.com/af");
  });

  test("refuses other protocols, unparsable URLs and URLs over 2,048 chars", async () => {
    await refusal("ftp://hooks.example.com/af");
    await refusal("file:///etc/passwd");
    await refusal("not a url");
    await refusal(`https://hooks.example.com/${"a".repeat(2048)}`);
  });
});

describe("Teredo and SIIT targets", () => {
  test.each([TEREDO, "2001::1", SIIT_PUBLIC, SIIT_LOOPBACK, "::ffff:0:808:808"])(
    "isPrivateAddress(%s) is true",
    (address) => {
      expect(isPrivateAddress(address)).toBe(true);
    }
  );

  // Controls: a public address next to each range stays reachable.
  test.each(["2001:4860:4860::8888", "2001:1::1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:1:808:808"])(
    "isPrivateAddress(%s) is false",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    }
  );

  test("create time refuses a Teredo or SIIT literal and a name resolving to one", async () => {
    await refusal(`https://[${TEREDO}]/hook`);
    await refusal(`https://[${SIIT_PUBLIC}]/hook`);
    await refusal(`https://[${SIIT_LOOPBACK}]/hook`);
    await refusal("https://teredo.example.com/hook");
    await refusal("https://siit.example.com/hook");
    // Control: a name resolving to a public IPv6 is accepted.
    await assertWebhookUrl("https://v6.example.com/hook", { env: {}, resolve });
  });

  test("send time refuses a Teredo or SIIT target before any request is made", async () => {
    const calls: string[] = [];
    const baseFetch = (async (input: string | URL | Request) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const guarded = webhookFetch({ env: {}, baseFetch, resolve });
    for (const url of [
      "https://teredo.example.com/af",
      "https://siit.example.com/af",
      `https://[${TEREDO}]/af`,
      `https://[${SIIT_LOOPBACK}]/af`,
    ]) {
      await expect(guarded(url, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(EgressDeniedError);
    }
    expect(calls).toEqual([]);
    // Control: the same fetch reaches a public IPv6 target.
    const res = await guarded("https://v6.example.com/af", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe("webhookEgressConfig", () => {
  test("parses the allowlist and the private flag", () => {
    expect(webhookEgressConfig({})).toEqual({ allowedHosts: null, allowPrivate: false });
    expect(
      webhookEgressConfig({
        AGENT_FS_WEBHOOK_ALLOWED_HOSTS: " receiver:8080 , *.svc.local ",
        AGENT_FS_WEBHOOK_ALLOW_PRIVATE: "true",
      })
    ).toEqual({ allowedHosts: ["receiver:8080", "*.svc.local"], allowPrivate: true });
    expect(webhookEgressConfig({ AGENT_FS_WEBHOOK_ALLOW_PRIVATE: "1" }).allowPrivate).toBe(false);
  });

  test("an invalid allowlist entry throws", () => {
    expect(() => webhookEgressConfig({ AGENT_FS_WEBHOOK_ALLOWED_HOSTS: "http://receiver" })).toThrow(
      "Invalid AGENT_FS_WEBHOOK_ALLOWED_HOSTS entry"
    );
  });
});

describe("webhookFetch", () => {
  function recordingFetch() {
    const calls: Array<{ url: string; host: string | null }> = [];
    const baseFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, host: new Headers(init?.headers).get("host") });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    return { calls, baseFetch };
  }

  test("connects to the checked address, keeping the Host header", async () => {
    const { calls, baseFetch } = recordingFetch();
    const guarded = webhookFetch({ env: {}, baseFetch, resolve });
    const res = await guarded("https://hooks.example.com/af", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: "https://93.184.216.34/af", host: "hooks.example.com" }]);
  });

  test("refuses a private target before any request is made", async () => {
    const { calls, baseFetch } = recordingFetch();
    const guarded = webhookFetch({ env: {}, baseFetch, resolve });
    await expect(guarded("https://rebind.example.com/af", { method: "POST" })).rejects.toBeInstanceOf(
      EgressDeniedError
    );
    await expect(guarded("http://169.254.169.254/", { method: "POST" })).rejects.toBeInstanceOf(
      EgressDeniedError
    );
    expect(calls).toEqual([]);
  });

  test("an allowlisted private host is fetched as is", async () => {
    const { calls, baseFetch } = recordingFetch();
    const guarded = webhookFetch({
      env: { AGENT_FS_WEBHOOK_ALLOWED_HOSTS: "receiver:8080" },
      baseFetch,
      resolve,
    });
    await guarded("http://receiver:8080/hook", { method: "POST" });
    expect(calls.map((c) => c.url)).toEqual(["http://receiver:8080/hook"]);
  });

  test("the default instance is rebuilt when the env changes", () => {
    const a = webhookFetch({ env: {} });
    expect(webhookFetch({ env: {} })).toBe(a);
    const b = webhookFetch({ env: { AGENT_FS_WEBHOOK_ALLOWED_HOSTS: "receiver:8080" } });
    expect(b).not.toBe(a);
  });
});
