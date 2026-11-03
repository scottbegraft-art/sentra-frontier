import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildQuantumTapeRequest, meanConfidence, runAnalysis, validateImageInput } from "./analysis.js";
import { estimateCost, loadConfig } from "./config.js";
import { fixtureAnalysis } from "./fixtures.js";
import { parseSceneInterpretation, SCENE_PROMPT } from "./providers/meta.js";
import { decodeSamOutput, FixtureSamAdapter } from "./providers/sam.js";
import { testSparkConnectivity } from "./providers/meta.js";

const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("validateImageInput", () => {
  it("accepts a small PNG", () => {
    assert.equal(validateImageInput("image/png", tinyPng).mime, "image/png");
  });
  it("rejects unsupported types and oversized data", () => {
    assert.throws(() => validateImageInput("image/gif", tinyPng), /JPEG, PNG, or WebP/);
    assert.throws(() => validateImageInput("image/png", "x".repeat(20_000_000)), /8 MB/);
  });
});

describe("parseSceneInterpretation", () => {
  it("accepts a well-formed interpretation and rejects a bad one", () => {
    const good = {
      sceneSummary: "A workbench.",
      categories: ["workbench"],
      observations: [{ kind: "observation", text: "Bench visible.", evidence: "Image", confidence: 0.8 }],
      issues: [{ title: "None", severity: "low", description: "No issue." }],
      plan: [{ title: "Tidy", detail: "Tidy up." }],
    };
    assert.equal(parseSceneInterpretation(good).sceneSummary, "A workbench.");
    assert.throws(() => parseSceneInterpretation({ ...good, observations: [{ kind: "guess", text: "x", evidence: "y", confidence: 2 }] }), /observations/);
  });
  it("prompt requires observation/assumption labeling", () => {
    assert.match(SCENE_PROMPT, /assumption/);
  });
});

describe("fixture mode", () => {
  it("returns a labeled fixture analysis without any network call", async () => {
    const config = loadConfig({ ...process.env, META_API_KEY: "" });
    const a = await runAnalysis(config, { mime: "image/png", base64: tinyPng });
    assert.equal(a.mode, "fixture");
    assert.equal(a.approval, "awaiting_approval");
    assert.match(a.honestyNote, /FIXTURE MODE/);
    assert.ok(a.detections.length >= 1);
    assert.ok(a.plan.every((t) => t.status === "proposed"));
  });
  it("fixture SAM only returns boxes for requested categories", async () => {
    const sam = new FixtureSamAdapter();
    const result = await sam.segment("data:image/png;base64,x", ["tool"]);
    assert.ok(result.detections.every((d) => d.category === "tool"));
  });
  it("live SAM decoding produces real boxes and masks from parser-format text", async () => {
    // Recorded format from @meta-sam/parser docs: frame <0f>, one box + one mask.
    const output =
      "<0f>0<|box;x1=10;y1=20;x2=109;y2=119;w=200;h=200|>" +
      "<|mask;x=0;y=0;data=10,20,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";
    const { detections, warnings } = await decodeSamOutput(output, "tool", 1);
    assert.equal(detections.length, 1);
    assert.equal(detections[0].category, "tool");
    assert.equal(detections[0].source, "live");
    assert.equal(detections[0].maskAvailable, true);
    assert.ok(detections[0].maskSvgPath && detections[0].maskSvgPath.startsWith("M"));
    // Box fractions: left 10/200, top 20/200, width 100/200, height 100/200.
    assert.equal(detections[0].box.x, 0.05);
    assert.equal(detections[0].box.y, 0.1);
    assert.equal(warnings.length, 0);
  });
  it("zero-match SAM output returns zero detections, not a fake box", async () => {
    const { detections } = await decodeSamOutput("", "unicorn", 1);
    assert.equal(detections.length, 0);
  });
  it("connectivity test without a key reports the blocker, not a fake success", async () => {
    const config = loadConfig({ ...process.env, MODEL_API_KEY: "", META_API_KEY: "" });
    const result = await testSparkConnectivity(config);
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, null);
    assert.match(result.error ?? "", /No API key/);
  });
  it("connectivity test with a stubbed successful Spark call records usage", async () => {
    const config = loadConfig({ ...process.env, MODEL_API_KEY: "test-key-not-real", META_API_KEY: "" });
    const stub = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200 })) as typeof fetch;
    const result = await testSparkConnectivity(config, stub);
    assert.equal(result.ok, true);
    assert.equal(result.responseText, "OK");
    assert.equal(result.promptTokens, 10);
    assert.equal(result.completionTokens, 2);
    assert.ok((result.estimatedCostUsd ?? 0) > 0);
  });
});

describe("Quantum Tape contract", () => {
  it("builds a gated request with risk and approvalRequired=true", () => {
    const f = fixtureAnalysis("x");
    const q = buildQuantumTapeRequest({ ...f, sceneSummary: f.sceneSummary });
    assert.equal(q.version, 1);
    assert.equal(q.approvalRequired, true);
    assert.equal(q.assumptionCount, 1);
    assert.ok(["BALANCED", "DEEP"].includes(q.mode));
  });
});

describe("cost and confidence math", () => {
  it("estimates Spark cost from published per-million rates", () => {
    assert.equal(estimateCost("muse-spark-1.3", 1_000_000, 1_000_000), 5.5);
    assert.equal(estimateCost("muse-wonder-1.0", 1_000_000, 1_000_000), 24);
    assert.equal(estimateCost("muse-spark-1.3", null, 10), null);
  });
  it("averages confidence", () => {
    assert.equal(meanConfidence([0.5, 0.3]), 0.4);
    assert.equal(meanConfidence([]), 0);
  });
});
