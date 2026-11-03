import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixtureCouncil } from "./council.js";
import type { Analysis } from "./types.js";
import { Store } from "./store.js";

function sampleAnalysis(): Analysis {
  return {
    id: "a1",
    createdAt: new Date().toISOString(),
    mode: "fixture",
    sceneSummary: "FIXTURE",
    categories: ["tool"],
    detections: [],
    observations: [
      { id: "obs-1", kind: "observation", text: "Bench present.", evidence: "Fixture", confidence: 0.5, detectionIds: [] },
    ],
    issues: [],
    council: null,
    samWarnings: [],
    evidenceLinks: [],
    droppedCitationIds: [],
    plan: [{ id: "task-1", title: "Do it", detail: "Detail", status: "proposed" }],
    usage: [],
    overallConfidence: 0.5,
    honestyNote: "FIXTURE",
    approval: "awaiting_approval",
    approvedAt: null,
    decidedBy: null,
  };
}

describe("fixture council", () => {
  it("has all three roles and blocks unsupported certainty", () => {
    const c = fixtureCouncil(sampleAnalysis().observations);
    assert.equal(c.mode, "fixture");
    assert.equal(c.analyst.role, "analyst");
    assert.equal(c.critic.role, "critic");
    assert.equal(c.planner.role, "planner");
    assert.ok(c.disagreements.length >= 1);
    assert.ok(c.critic.points.some((p) => /placeholder|fixture/i.test(p)));
  });
});

describe("store decisions and persistence", () => {
  it("approve creates approved tasks, a second decision is a duplicate, reject creates none", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "frontier-store-"));
    const store = new Store(dir);
    await store.init();
    await store.add(sampleAnalysis());
    const first = await store.decide("a1", true, "demo-user");
    assert.equal(first.duplicate, false);
    assert.equal(first.analysis?.approval, "approved");
    assert.equal(first.analysis?.plan[0].status, "approved");
    const second = await store.decide("a1", false, "demo-user");
    assert.equal(second.duplicate, true);
    assert.equal(second.analysis?.approval, "approved");
    assert.equal(second.analysis?.plan[0].status, "approved");

    const other = sampleAnalysis();
    other.id = "a2";
    await store.add(other);
    const rejected = await store.decide("a2", false, "demo-user");
    assert.equal(rejected.analysis?.approval, "rejected");
    assert.equal(rejected.analysis?.plan[0].status, "rejected");
  });

  it("analyses and audit survive a store restart (new Store, same dir)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "frontier-store-"));
    const s1 = new Store(dir);
    await s1.init();
    await s1.add(sampleAnalysis());
    await s1.decide("a1", true, "demo-user");
    const s2 = new Store(dir);
    await s2.init();
    const restored = s2.get("a1");
    assert.equal(restored?.approval, "approved");
    assert.equal(restored?.decidedBy, "demo-user");
    assert.ok(s2.auditFor("a1").some((e) => e.event === "tasks_approved"));
  });
});
