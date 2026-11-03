import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideBillableAccess, isLoopbackAddress } from "./billable.js";
import { loadConfig } from "./config.js";
import { RateLimiter } from "./rateLimit.js";

const LOCAL = {
  billableAccess: "localhost-only" as const,
  approvalToken: null,
  billableRateLimitPerMinute: 30,
};

describe("isLoopbackAddress", () => {
  it("accepts only real loopback addresses", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("203.0.113.5"), false);
    assert.equal(isLoopbackAddress("::ffff:203.0.113.5"), false);
    assert.equal(isLoopbackAddress("192.168.1.10"), false);
    assert.equal(isLoopbackAddress(null), false);
    assert.equal(isLoopbackAddress(undefined), false);
    assert.equal(isLoopbackAddress(""), false);
    assert.equal(isLoopbackAddress("localhost"), false, "a hostname is not an address");
  });
});

describe("decideBillableAccess — forged Host cannot bypass local-only (Phase 1D)", () => {
  it("a remote IP with a forged Host: localhost header is DENIED (Host is never consulted)", () => {
    // decideBillableAccess takes no Host parameter at all: there is no
    // way for a Host header to influence this decision. This test
    // documents that property at the type level by passing only a
    // remote address — the old code's `host.startsWith("localhost")`
    // escape hatch is gone.
    const d = decideBillableAccess(LOCAL, { remoteAddress: "203.0.113.5", tokenHeader: null }, new RateLimiter(30));
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.status, 403);
  });

  it("a loopback remote address is allowed regardless of any header value", () => {
    for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const d = decideBillableAccess(LOCAL, { remoteAddress: remote, tokenHeader: null }, new RateLimiter(30));
      assert.equal(d.allowed, true, remote);
    }
  });

  it("a missing remote address is denied", () => {
    const d = decideBillableAccess(LOCAL, { remoteAddress: null, tokenHeader: null }, new RateLimiter(30));
    assert.equal(d.allowed, false);
  });

  it("token-required mode checks the token, misconfigured mode refuses everything", () => {
    const tokenCfg = { ...LOCAL, billableAccess: "token-required" as const, approvalToken: "secret-token" };
    assert.equal(decideBillableAccess(tokenCfg, { remoteAddress: "203.0.113.5", tokenHeader: "secret-token" }, new RateLimiter(30)).allowed, true);
    assert.equal(decideBillableAccess(tokenCfg, { remoteAddress: "203.0.113.5", tokenHeader: "wrong" }, new RateLimiter(30)).allowed, false);
    const bad = { ...LOCAL, billableAccess: "misconfigured" as const };
    const d = decideBillableAccess(bad, { remoteAddress: "127.0.0.1", tokenHeader: "anything" }, new RateLimiter(30));
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.status, 503);
  });

  it("rate limit still applies after authorization", () => {
    const limiter = new RateLimiter(1);
    assert.equal(decideBillableAccess(LOCAL, { remoteAddress: "127.0.0.1", tokenHeader: null }, limiter).allowed, true);
    const d = decideBillableAccess(LOCAL, { remoteAddress: "127.0.0.1", tokenHeader: null }, limiter);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.status, 429);
  });
});

describe("bindHost config (Phase 1D)", () => {
  it("defaults to loopback and honors an explicit override", () => {
    assert.equal(loadConfig({}).bindHost, "127.0.0.1");
    assert.equal(loadConfig({ FRONTIER_BIND_HOST: "0.0.0.0" }).bindHost, "0.0.0.0");
  });
});
