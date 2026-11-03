import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDotEnv } from "./config.js";
import { decodeSamOutput, extractSamOutputText } from "./providers/sam.js";
import { RateLimiter } from "./rateLimit.js";

const FRAME =
  "<0f>0<|box;x1=10;y1=20;x2=109;y2=119;w=200;h=200|>" +
  "<|mask;x=0;y=0;data=10,20,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";

function sseEvent(type: string, payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, ...payload })}`;
}

describe("extractSamOutputText — no duplication (Phase 1C)", () => {
  it("concatenates deltas when there is no final assembled event", () => {
    const body = [
      sseEvent("response.output_text.delta", { delta: "<0f>0<|box;" }),
      sseEvent("response.output_text.delta", { delta: "x1=10|>" }),
    ].join("\n");
    assert.equal(extractSamOutputText(body), "<0f>0<|box;x1=10|>");
  });

  it("done text wins over deltas — no duplication", async () => {
    const body = [
      sseEvent("response.output_text.delta", { delta: FRAME }),
      sseEvent("response.output_text.done", { text: FRAME }),
      sseEvent("response.completed", {}),
    ].join("\n");
    assert.equal(extractSamOutputText(body), FRAME);
    const { detections } = await decodeSamOutput(extractSamOutputText(body), "tool", 1);
    assert.equal(detections.length, 1, "duplicated output would decode twice");
  });

  it("completed assembled output wins over deltas", () => {
    const body = [
      sseEvent("response.output_text.delta", { delta: FRAME }),
      sseEvent("response.completed", {
        response: { output: [{ content: [{ text: FRAME }] }] },
      }),
    ].join("\n");
    assert.equal(extractSamOutputText(body), FRAME);
  });

  it("done before deltas still wins, and unknown/malformed lines are ignored", () => {
    const body = [
      "data: not-json{",
      sseEvent("response.reasoning.delta", { delta: "SHOULD-NOT-APPEAR" }),
      sseEvent("response.output_text.done", { text: FRAME }),
      sseEvent("response.output_text.delta", { delta: "EXTRA" }),
    ].join("\n");
    assert.equal(extractSamOutputText(body), FRAME);
  });

  it("empty output is a valid zero-match outcome, not an error", async () => {
    assert.equal(extractSamOutputText(""), "");
    const { detections } = await decodeSamOutput("", "unicorn", 1);
    assert.equal(detections.length, 0);
  });
});

describe("decodeSamOutput — malformed and unexpected input", () => {
  it("malformed stream text yields zero detections without throwing", async () => {
    const { detections } = await decodeSamOutput("<0f>garbage-not-a-record", "tool", 1);
    assert.equal(detections.length, 0);
  });

  it("a box without a mask is malformed and dropped, not rendered as a box", async () => {
    const boxOnly = "<0f>0<|box;x1=10;y1=20;x2=109;y2=119;w=200;h=200|>";
    const { detections } = await decodeSamOutput(boxOnly, "tool", 1);
    assert.equal(detections.length, 0);
  });

  it("mask decoding produces a raster-sized SVG path and correct fractions", async () => {
    const { detections } = await decodeSamOutput(FRAME, "tool", 1);
    assert.equal(detections.length, 1);
    assert.equal(detections[0].maskRasterWidth, 20);
    assert.equal(detections[0].maskRasterHeight, 10);
    assert.ok(detections[0].maskSvgPath?.startsWith("M"));
    assert.equal(detections[0].box.width, 0.5);
  });
});

describe("loadDotEnv", () => {
  it("loads a .env file without overriding existing env, and tolerates a missing file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "frontier-dotenv-"));
    await writeFile(path.join(dir, ".env"), "# comment\nFRONTIER_TEST_DOTENV_KEY=hello\nQUOTED=\"a b\"\n");
    delete process.env.FRONTIER_TEST_DOTENV_KEY;
    const loaded = loadDotEnv([dir]);
    assert.ok(loaded.includes("FRONTIER_TEST_DOTENV_KEY"));
    assert.equal(process.env.FRONTIER_TEST_DOTENV_KEY, "hello");
    assert.equal(process.env.QUOTED, "a b");
    // Missing directory: no throw, no keys.
    assert.deepEqual(loadDotEnv([path.join(dir, "does-not-exist")]), []);
    delete process.env.FRONTIER_TEST_DOTENV_KEY;
    delete process.env.QUOTED;
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit per window, then blocks, then allows after the window", () => {
    const limiter = new RateLimiter(2, 60_000);
    assert.equal(limiter.allow("1.2.3.4", 1000), true);
    assert.equal(limiter.allow("1.2.3.4", 2000), true);
    assert.equal(limiter.allow("1.2.3.4", 3000), false);
    assert.equal(limiter.allow("1.2.3.4", 1000 + 60_001), true);
    assert.equal(limiter.allow("5.6.7.8", 3000), true);
  });
});
