import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { Webhook } from "standardwebhooks";
import {
  decodeWebhookSecret,
  generateWebhookSecret,
  signWebhook,
  verifyWebhookSignature,
} from "../signature.js";

// Standard Webhooks spec test vector (spec README / svix test suite).
const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

function headersFor(id: string, ts: number, signature: string): Record<string, string> {
  return {
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": signature,
  };
}

afterEach(() => {
  setSystemTime();
});

describe("spec vector", () => {
  test("signWebhook reproduces the published signature", () => {
    expect(signWebhook(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(
      VECTOR.signature
    );
  });

  test("the standardwebhooks library agrees with the vector", () => {
    const wh = new Webhook(VECTOR.secret);
    expect(wh.sign(VECTOR.id, new Date(VECTOR.timestamp * 1000), VECTOR.body)).toBe(
      VECTOR.signature
    );
    setSystemTime(new Date(VECTOR.timestamp * 1000));
    expect(
      wh.verify(VECTOR.body, headersFor(VECTOR.id, VECTOR.timestamp, VECTOR.signature))
    ).toEqual({ test: 2432232314 });
  });

  test("the copied verifier accepts the vector", () => {
    const key = decodeWebhookSecret(VECTOR.secret)!;
    expect(
      verifyWebhookSignature(
        key,
        VECTOR.body,
        { id: VECTOR.id, timestamp: String(VECTOR.timestamp), signature: VECTOR.signature },
        {},
        VECTOR.timestamp * 1000
      )
    ).toBe(true);
  });
});

describe("signWebhook against the standardwebhooks library", () => {
  test("sign then verify round-trips for a fresh secret", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(decodeWebhookSecret(secret)!.length).toBe(32);

    const body = JSON.stringify({ type: "comment.created", data: { note: "héllo ✓" } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signWebhook(secret, "evt_1", ts, body);

    expect(new Webhook(secret).verify(body, headersFor("evt_1", ts, sig))).toEqual(
      JSON.parse(body)
    );
    expect(
      verifyWebhookSignature(decodeWebhookSecret(secret)!, body, {
        id: "evt_1",
        timestamp: String(ts),
        signature: sig,
      })
    ).toBe(true);
  });

  test("a wrong secret fails", () => {
    const body = '{"a":1}';
    const ts = Math.floor(Date.now() / 1000);
    const sig = signWebhook(generateWebhookSecret(), "evt_2", ts, body);
    const other = generateWebhookSecret();

    expect(() => new Webhook(other).verify(body, headersFor("evt_2", ts, sig))).toThrow();
    expect(
      verifyWebhookSignature(decodeWebhookSecret(other)!, body, {
        id: "evt_2",
        timestamp: String(ts),
        signature: sig,
      })
    ).toBe(false);
  });

  test("a changed body or id fails", () => {
    const secret = generateWebhookSecret();
    const ts = Math.floor(Date.now() / 1000);
    const sig = signWebhook(secret, "evt_3", ts, '{"a":1}');
    expect(() => new Webhook(secret).verify('{"a":2}', headersFor("evt_3", ts, sig))).toThrow();
    expect(() => new Webhook(secret).verify('{"a":1}', headersFor("evt_4", ts, sig))).toThrow();
  });

  test("a stale timestamp fails", () => {
    const secret = generateWebhookSecret();
    const body = '{"a":1}';
    const stale = Math.floor(Date.now() / 1000) - 600;
    const sig = signWebhook(secret, "evt_5", stale, body);

    expect(() => new Webhook(secret).verify(body, headersFor("evt_5", stale, sig))).toThrow(
      /too old/
    );
    expect(
      verifyWebhookSignature(decodeWebhookSecret(secret)!, body, {
        id: "evt_5",
        timestamp: String(stale),
        signature: sig,
      })
    ).toBe(false);
  });

  test("any matching v1 entry in a space-delimited list passes (rotation)", () => {
    const secret = generateWebhookSecret();
    const body = '{"a":1}';
    const ts = Math.floor(Date.now() / 1000);
    const good = signWebhook(secret, "evt_6", ts, body);
    const bad = signWebhook(generateWebhookSecret(), "evt_6", ts, body);
    const header = `${bad} v1a,ignored ${good}`;
    expect(new Webhook(secret).verify(body, headersFor("evt_6", ts, header))).toEqual({ a: 1 });
    expect(
      verifyWebhookSignature(decodeWebhookSecret(secret)!, body, {
        id: "evt_6",
        timestamp: String(ts),
        signature: header,
      })
    ).toBe(true);
  });
});

describe("decodeWebhookSecret", () => {
  test("fails closed on malformed secrets", () => {
    expect(decodeWebhookSecret("whsec_")).toBeNull();
    expect(decodeWebhookSecret("whsec_not base64!")).toBeNull();
    expect(decodeWebhookSecret("whsec_a")).toBeNull();
    expect(() => signWebhook("whsec_", "id", 1, "{}")).toThrow();
  });

  test("accepts a secret without the whsec_ prefix", () => {
    expect(decodeWebhookSecret("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")).toEqual(
      decodeWebhookSecret(VECTOR.secret)
    );
  });
});
