import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redact, whitelistFilter } from "../lib/redactor.mjs";

describe("Redaction", () => {
  test("redact removes api_key values", () => {
    const r = redact({ api_key: "sk-1234567890abcdef", name: "safe" });
    assert.equal(r.api_key, "[redacted]");
    assert.equal(r.name, "safe");
  });

  test("redact removes Bearer tokens", () => {
    const r = redact({ authorization: "Bearer abcdef1234567890", data: "ok" });
    assert.notEqual(r.authorization, "Bearer abcdef1234567890");
  });

  test("redact handles nested objects", () => {
    const r = redact({ outer: { secret: "rk_test1234567890123456", value: 42 } });
    assert.notEqual(r.outer.secret, "rk_test1234567890123456");
    assert.equal(r.outer.value, 42);
  });

  test("redact handles arrays", () => {
    const r = redact({ items: [{ api_key: "sk_test123456789", ok: 1 }, { safe: "yes" }] });
    assert.equal(r.items[0].api_key, "[redacted]");
    assert.equal(r.items[0].ok, 1);
    assert.equal(r.items[1].safe, "yes");
  });

  test("redact preserves safe string values", () => {
    const r = redact({ model: "deepseek-v4.1-flash", tokens: 34506 });
    assert.equal(r.model, "deepseek-v4.1-flash");
    assert.equal(r.tokens, 34506);
  });

  test("redact removes cookie/password fields", () => {
    const r = redact({ cookie: "session=abc123", password: "secret123", normal: "ok" });
    assert.equal(r.cookie, "[redacted]");
    assert.equal(r.password, "[redacted]");
    assert.equal(r.normal, "ok");
  });
});

describe("Whitelist Filter", () => {
  test("whitelistFilter keeps safe keys", () => {
    const r = whitelistFilter({ agent_object: "workbuddy", session_id: "s1", tokens: { input: 100 } });
    assert.equal(r.agent_object, "workbuddy");
    assert.equal(r.session_id, "s1");
    assert.deepEqual(r.tokens, { input: 100 });
  });

  test("whitelistFilter removes unsafe keys", () => {
    const r = whitelistFilter({ session_id: "s1", raw_prompt: "secret system prompt", api_key: "sk_xxx" });
    assert.equal(r.session_id, "s1");
    assert.equal(r.raw_prompt, undefined);
    assert.equal(r.api_key, undefined);
  });

  test("whitelistFilter handles arrays", () => {
    const r = whitelistFilter({ items: [{ session_id: "s1", raw_content: "secret" }] });
    assert.equal(r.items[0].session_id, "s1");
    assert.equal(r.items[0].raw_content, undefined);
  });

  test("whitelistFilter preserves null values", () => {
    const r = whitelistFilter({ session_id: null, tokens: null });
    assert.equal(r.session_id, null);
    assert.equal(r.tokens, null);
  });

  test("combined redact + whitelistFilter is safe", () => {
    const data = { session_id: "s1", api_key: "sk_1234567890abcdef", tokens: { input: 34506 } };
    const r = whitelistFilter(redact(data));
    assert.equal(r.session_id, "s1");
    assert.equal(r.api_key, undefined);
    assert.equal(r.tokens.input, 34506);
  });
});
