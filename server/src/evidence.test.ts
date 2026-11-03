import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceLinks, compareCouncilToPlan, validateCitationIds } from "./evidence.js";
import type { Council, Observation } from "./types.js";

const obs: Observation[] = [
  { id: "obs-1", kind: "observation", text: "Workbench is cluttered.", evidence: "Photo", confidence: 0.8, detectionIds: [] },
  { id: "obs-2", kind: "assumption", text: "Workers may trip on cables.", evidence: "Assumption, not observed.", confidence: 0.4, detectionIds: [] },
];

function councilWith(cited: string[]): Council {
  return {
    mode: "fixture",
    analyst: { role: "analyst", position: "A", points: ["a"], evidenceObservationIds: [], error: null },
    critic: { role: "critic", position: "C", points: ["c"], evidenceObservationIds: [], error: null },
    planner: { role: "planner", position: "P", points: ["p"], evidenceObservationIds: cited, error: null },
    disagreements: ["d"],
    openQuestions: ["q"],
    recommendations: [{ id: "rec-1", text: "Tidy the bench.", observationIds: cited }],
  };
}

describe("evidence links (Final Sprint)", () => {
  it("valid citations become links with cited text; invalid ids are dropped, never linked", () => {
    const { links, droppedCitationIds, filteredCouncil } = buildEvidenceLinks(
      councilWith(["obs-1", "obs-999", "obs-2"]),
      obs,
    );
    assert.equal(links.length, 2);
    assert.deepEqual(links.map((l) => l.toId), ["obs-1", "obs-2"]);
    assert.equal(links[0].basis, "council-citation");
    assert.equal(links[0].citedText, "Workbench is cluttered.");
    assert.deepEqual(droppedCitationIds, ["obs-999"]);
    assert.deepEqual(filteredCouncil.recommendations[0].observationIds, ["obs-1", "obs-2"]);
  });

  it("missing evidence produces no links and no crash", () => {
    const { links, droppedCitationIds } = buildEvidenceLinks(councilWith(["obs-1"]), []);
    assert.equal(links.length, 0);
    assert.deepEqual(droppedCitationIds, ["obs-1"]);
  });

  it("label matching alone never creates an observation→detection link", () => {
    // A detection labeled "cable" and an observation mentioning cables
    // share a word. That is not provenance. buildEvidenceLinks only
    // links council recommendations to observations, so no detection
    // link can appear here by construction.
    const { links } = buildEvidenceLinks(councilWith(["obs-1"]), obs);
    assert.equal(links.filter((l) => l.toType === "detection").length, 0);
    assert.equal(links.filter((l) => l.fromType === "observation").length, 0);
  });

  it("validateCitationIds separates valid from dropped", () => {
    assert.deepEqual(validateCitationIds(["a", "b"], new Set(["a"])), { valid: ["a"], dropped: ["b"] });
  });
});

describe("council comparison (Final Sprint)", () => {
  it("computes shared/council-only/plan-only textually and disclaims accuracy", () => {
    const c = compareCouncilToPlan(
      ["Tidy the workbench", "Label the bins"],
      ["Tidy the workbench daily", "Buy a new robot"],
    );
    assert.deepEqual(c.shared, ["Tidy the workbench daily"]);
    assert.deepEqual(c.councilOnly, ["Buy a new robot"]);
    assert.deepEqual(c.planOnly, ["Label the bins"]);
    assert.match(c.note, /NOT an accuracy/);
  });
});

describe("council distinctness (Final Sprint)", () => {
  it("fixture council roles have distinct positions and a real critic challenge", async () => {
    const { fixtureCouncil } = await import("./council.js");
    const c = fixtureCouncil(obs);
    const positions = new Set([c.analyst.position, c.critic.position, c.planner.position]);
    assert.equal(positions.size, 3, "roles must not be paraphrases of one position");
    assert.ok(c.critic.points.length > 0);
    assert.ok(c.disagreements.length > 0);
    assert.ok(c.recommendations[0].id.startsWith("rec-"));
  });
});
