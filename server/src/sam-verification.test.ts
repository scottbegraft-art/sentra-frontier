import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LiveSamAdapter } from "./providers/sam.js";
import { loadConfig } from "./config.js";

const FRAME =
  "<0f>0<|box;x1=10;y1=20;x2=109;y2=119;w=200;h=200|>" +
  "<|mask;x=0;y=0;data=10,20,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";

function stubFetch(bodyText: string, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    text: async () => bodyText,
  })) as unknown as typeof fetch;
}

const config = loadConfig({ MODEL_API_KEY: "dummy-for-tests-only", META_API_BASE_URL: "https://example.invalid/v1" });

describe("LiveSamAdapter — verification semantics (Phase 1D)", () => {
  it("valid decoded output: protocolOk + decodedOk, detections present", async () => {
    const sam = new LiveSamAdapter(config, stubFetch(FRAME));
    const r = await sam.segment("data:image/png;base64,AAAA", ["tool"]);
    assert.equal(r.perPhrase.length, 1);
    assert.deepEqual(
      { attempted: r.perPhrase[0].attempted, protocolOk: r.perPhrase[0].protocolOk, decodedOk: r.perPhrase[0].decodedOk, detections: r.perPhrase[0].detections },
      { attempted: true, protocolOk: true, decodedOk: true, detections: 1 },
    );
    assert.equal(r.detections.length, 1);
  });

  it("malformed output with HTTP 200: usage recorded, decodedOk FALSE — must not verify (regression for the old usage-based check)", async () => {
    const sam = new LiveSamAdapter(config, stubFetch("<0f>garbage-not-a-record"));
    const r = await sam.segment("data:image/png;base64,AAAA", ["tool"]);
    assert.equal(r.perPhrase[0].protocolOk, true, "HTTP 200 is a protocol success");
    assert.equal(r.perPhrase[0].decodedOk, false, "malformed output is not a successful interpretation");
    assert.equal(r.detections.length, 0);
    assert.equal(r.usage.length, 1, "estimated usage is still recorded separately — usage alone is not verification");
    assert.equal(r.perPhrase.filter((p) => p.decodedOk).length, 0, "old server check (any live usage) would have falsely verified this");
  });

  it("valid completed zero-match: decodedOk TRUE with zero detections", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_text.done", text: "" })}`,
      `data: ${JSON.stringify({ type: "response.completed" })}`,
    ].join("\n");
    const sam = new LiveSamAdapter(config, stubFetch(sse));
    const r = await sam.segment("data:image/png;base64,AAAA", ["unicorn"]);
    assert.equal(r.perPhrase[0].protocolOk, true);
    assert.equal(r.perPhrase[0].decodedOk, true);
    assert.equal(r.detections.length, 0);
  });

  it("empty output with NO completion marker: truncated, decodedOk FALSE — not a zero-match", async () => {
    const sam = new LiveSamAdapter(config, stubFetch(""));
    const r = await sam.segment("data:image/png;base64,AAAA", ["tool"]);
    assert.equal(r.perPhrase[0].protocolOk, true);
    assert.equal(r.perPhrase[0].decodedOk, false);
  });

  it("HTTP 500: protocolOk FALSE, decodedOk FALSE, no usage", async () => {
    const sam = new LiveSamAdapter(config, stubFetch("server error", false, 500));
    const r = await sam.segment("data:image/png;base64,AAAA", ["tool"]);
    assert.equal(r.perPhrase[0].protocolOk, false);
    assert.equal(r.perPhrase[0].decodedOk, false);
    assert.equal(r.usage.length, 0);
    assert.equal(r.detections.length, 0);
  });

  it("mixed phrases: only decoded phrases count", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, status: 200, text: async () => FRAME }
        : { ok: true, status: 200, text: async () => "<0f>garbage" };
    }) as unknown as typeof fetch;
    const sam = new LiveSamAdapter(config, fetchFn);
    const r = await sam.segment("data:image/png;base64,AAAA", ["tool", "widget"]);
    assert.equal(r.perPhrase.filter((p) => p.decodedOk).length, 1);
    assert.equal(r.perPhrase.filter((p) => p.protocolOk).length, 2);
    assert.equal(r.perPhrase.filter((p) => p.attempted).length, 2);
  });
});
