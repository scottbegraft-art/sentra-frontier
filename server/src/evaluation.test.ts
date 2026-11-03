import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAnalysis, validateImageInput } from "./analysis.js";
import { calculateImprovement } from "./calculator.js";
import { loadConfig } from "./config.js";
import { buildEvidenceLinks } from "./evidence.js";
import { LiveSamAdapter } from "./providers/sam.js";
import { testSparkConnectivity } from "./providers/meta.js";
import { Store } from "./store.js";
import type { Analysis, Observation } from "./types.js";

/**
 * Final Sprint evaluation dataset (see docs/EVALUATION.md).
 * 15 cases, all synthetic/permitted: the 1x1 PNG is a test fixture,
 * not a workstation photograph. Fixture-mode results are labeled as
 * such; no live Meta result is claimed anywhere in this suite.
 */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const fixtureConfig = loadConfig({});

describe("evaluation dataset (Final Sprint)", () => {
  it("E1: valid PNG image is accepted and analyzed in fixture mode", async () => {
    const a = await runAnalysis(fixtureConfig, { mime: "image/png", base64: PNG_1X1 });
    assert.equal(a.mode, "fixture");
    assert.ok(a.detections.length > 0);
    assert.ok(a.observations.length > 0);
  });

  it("E2: invalid MIME type is rejected", () => {
    assert.throws(() => validateImageInput("image/gif", PNG_1X1));
  });

  it("E3: empty image data is rejected", () => {
    assert.throws(() => validateImageInput("image/png", ""));
  });

  it("E4: oversize image is rejected", () => {
    assert.throws(() => validateImageInput("image/png", "A".repeat(12_000_000)));
  });

  it("E5: non-base64 image data is rejected", () => {
    assert.throws(() => validateImageInput("image/png", "not base64 !!!"));
  });

  it("E6: evidence links — fixture council recommendation links to all fixture observations", async () => {
    const a = await runAnalysis(fixtureConfig, { mime: "image/png", base64: PNG_1X1 });
    assert.ok(a.evidenceLinks.length > 0);
    assert.deepEqual(a.droppedCitationIds, []);
    assert.ok(a.evidenceLinks.every((l) => l.basis === "council-citation"));
  });

  it("E7: evidence links — invalid citation ids are dropped, never linked", () => {
    const obs: Observation[] = [{ id: "obs-1", kind: "observation", text: "X", evidence: "Y", confidence: 0.5, detectionIds: [] }];
    const { links, droppedCitationIds } = buildEvidenceLinks(
      {
        mode: "fixture",
        analyst: { role: "analyst", position: "A", points: [], evidenceObservationIds: [], error: null },
        critic: { role: "critic", position: "C", points: [], evidenceObservationIds: [], error: null },
        planner: { role: "planner", position: "P", points: [], evidenceObservationIds: [], error: null },
        disagreements: [],
        openQuestions: [],
        recommendations: [{ id: "rec-1", text: "R", observationIds: ["obs-1", "obs-nope"] }],
      },
      obs,
    );
    assert.equal(links.length, 1);
    assert.deepEqual(droppedCitationIds, ["obs-nope"]);
  });

  it("E8: evidence links — label match alone creates no detection link", async () => {
    const a = await runAnalysis(fixtureConfig, { mime: "image/png", base64: PNG_1X1 });
    assert.equal(a.evidenceLinks.filter((l) => l.toType === "detection").length, 0);
    assert.equal(a.observations[0].detectionIds.length, 0);
  });

  it("E9: calculator — known case matches hand-computed values", () => {
    const r = calculateImprovement({ currentMinutesPerUnit: 10, proposedMinutesPerUnit: 8, unitsPerDay: 100, laborCostPerHourUsd: 20, workingDays: 20 });
    assert.equal(r.timeSavedPerUnitMinutes, 2);
    assert.ok(Math.abs(r.productivityChangePercent - 25) < 1e-9);
    assert.ok(Math.abs(r.laborHourValueUsd - ((200 / 60) * 20 * 20)) < 1e-6);
  });

  it("E10: calculator — invalid inputs are rejected, not corrected", () => {
    assert.throws(() => calculateImprovement({ currentMinutesPerUnit: 0, proposedMinutesPerUnit: 8, unitsPerDay: 100, laborCostPerHourUsd: 20, workingDays: 20 }));
  });

  it("E11: approvals — approve creates tasks, second decision is a duplicate (409 semantics)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "frontier-eval-"));
    const store = new Store(dir);
    await store.init();
    const a: Analysis = {
      id: "eval-1", createdAt: new Date().toISOString(), mode: "fixture", sceneSummary: "S", categories: [],
      detections: [], observations: [], issues: [], council: null, samWarnings: [], evidenceLinks: [], droppedCitationIds: [],
      plan: [{ id: "task-1", title: "T", detail: "D", status: "proposed" }], usage: [], overallConfidence: 0,
      honestyNote: "FIXTURE", approval: "awaiting_approval", approvedAt: null, decidedBy: null,
    };
    await store.add(a);
    const first = await store.decide("eval-1", true, "demo-user");
    assert.equal(first.duplicate, false);
    assert.equal(first.analysis?.plan[0].status, "approved");
    const second = await store.decide("eval-1", true, "demo-user");
    assert.equal(second.duplicate, true);
  });

  it("E12: approvals — reject creates no approved tasks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "frontier-eval-"));
    const store = new Store(dir);
    await store.init();
    const a: Analysis = {
      id: "eval-2", createdAt: new Date().toISOString(), mode: "fixture", sceneSummary: "S", categories: [],
      detections: [], observations: [], issues: [], council: null, samWarnings: [], evidenceLinks: [], droppedCitationIds: [],
      plan: [{ id: "task-1", title: "T", detail: "D", status: "proposed" }], usage: [], overallConfidence: 0,
      honestyNote: "FIXTURE", approval: "awaiting_approval", approvedAt: null, decidedBy: null,
    };
    await store.add(a);
    const r = await store.decide("eval-2", false, "demo-user");
    assert.equal(r.analysis?.plan[0].status, "rejected");
    assert.equal(r.analysis?.approval, "rejected");
  });

  it("E13: council — roles distinct, disagreements present, comparison disclaims accuracy", async () => {
    const a = await runAnalysis(fixtureConfig, { mime: "image/png", base64: PNG_1X1 });
    assert.ok(a.council);
    const positions = new Set([a.council.analyst.position, a.council.critic.position, a.council.planner.position]);
    assert.equal(positions.size, 3);
    assert.ok(a.council.disagreements.length > 0);
    assert.match(a.councilComparison?.note ?? "", /NOT an accuracy/);
  });

  it("E14: SAM verification — malformed HTTP-200 output does not verify, valid output does", async () => {
    const cfg = loadConfig({ MODEL_API_KEY: "dummy-for-tests-only", META_API_BASE_URL: "https://example.invalid/v1" });
    const bad = new LiveSamAdapter(cfg, (async () => ({ ok: true, status: 200, text: async () => "<0f>garbage" })) as unknown as typeof fetch);
    const badResult = await bad.segment("data:image/png;base64,AAAA", ["tool"]);
    assert.equal(badResult.perPhrase[0].decodedOk, false);
    const frame = "<0f>0<|box;x1=10;y1=20;x2=109;y2=119;w=200;h=200|><|mask;x=0;y=0;data=10,20,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";
    const good = new LiveSamAdapter(cfg, (async () => ({ ok: true, status: 200, text: async () => frame })) as unknown as typeof fetch);
    const goodResult = await good.segment("data:image/png;base64,AAAA", ["tool"]);
    assert.equal(goodResult.perPhrase[0].decodedOk, true);
  });

  it("E15: diagnostics — connectivity test without a key reports the blocker, no Meta call", async () => {
    const t = await testSparkConnectivity(fixtureConfig);
    assert.equal(t.ok, false);
    assert.match(t.error ?? "", /No API key/);
    assert.equal(t.httpStatus, null);
  });
});
