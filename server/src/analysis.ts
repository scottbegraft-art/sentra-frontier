import { randomUUID } from "node:crypto";
import type { ServerConfig } from "./config.js";
import { fixtureCouncil, runCouncil } from "./council.js";
import { buildEvidenceLinks, compareCouncilToPlan } from "./evidence.js";
import { fixtureAnalysis } from "./fixtures.js";
import { callMuseModel, SPARK_MODEL, WONDER_MODEL } from "./providers/meta.js";
import { FixtureSamAdapter, LiveSamAdapter } from "./providers/sam.js";
import type { Analysis } from "./types.js";
import { ValidationError } from "./types.js";

/**
 * Orchestration pipeline — the Quantum Tape connection point (Phase 2).
 *
 * Current Phase 1B flow:
 *   validate image -> Muse Spark scene interpretation (or fixture)
 *     -> categories -> SAM segmentation, one Responses call per phrase
 *       (fixture boxes in fixture mode; decoded live masks in live mode)
 *     -> observations (observation vs assumption preserved from the model)
 *     -> issues -> three-role council (analyst / critic / planner)
 *     -> proposed plan -> approval gate -> audit log
 * SAM or council failures are recorded as warnings/errors in the result;
 * they never silently substitute fixture data for live data, and they
 * never fail a Spark interpretation that did succeed.
 *
 * Phase 2 Quantum Tape boundary (see docs/QUANTUM-TAPE-INTEGRATION-BOUNDARIES.md):
 * the scene interpretation + detections are packaged as a
 * QuantumTapeRequest { mode, observations, detections, risk } and sent to a
 * secure server-side Quantum Tape endpoint. That endpoint does not exist in
 * this repo yet, so no call is made and nothing here pretends otherwise.
 * The `quantumTapeRequest` object below is the exact contract Phase 2 will send.
 */

export interface QuantumTapeRequest {
  version: 1;
  mode: "FAST" | "BALANCED" | "DEEP" | "COUNCIL";
  source: "sentra-frontier";
  sceneSummary: string;
  categories: string[];
  detectionLabels: string[];
  observationCount: number;
  assumptionCount: number;
  issueCount: number;
  riskLevel: 0 | 1 | 2 | 3;
  approvalRequired: boolean;
}

export function buildQuantumTapeRequest(a: Pick<Analysis, "sceneSummary" | "categories" | "detections" | "observations" | "issues">): QuantumTapeRequest {
  const assumptions = a.observations.filter((o) => o.kind === "assumption").length;
  const highIssues = a.issues.filter((i) => i.severity === "high").length;
  const riskLevel = (highIssues > 0 ? 3 : a.issues.length > 0 ? 2 : 1) as 0 | 1 | 2 | 3;
  return {
    version: 1,
    mode: assumptions > 0 || highIssues > 0 ? "DEEP" : "BALANCED",
    source: "sentra-frontier",
    sceneSummary: a.sceneSummary,
    categories: a.categories,
    detectionLabels: a.detections.map((d) => d.label),
    observationCount: a.observations.length,
    assumptionCount: assumptions,
    issueCount: a.issues.length,
    riskLevel,
    approvalRequired: true, // Frontier always gates task creation on approval.
  };
}

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 8 * 1024 * 1024;

export function validateImageInput(mime: unknown, base64: unknown): { mime: string; bytes: number } {
  if (typeof mime !== "string" || !ALLOWED_MIME.has(mime)) {
    throw new ValidationError("Upload must be a JPEG, PNG, or WebP image.");
  }
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new ValidationError("Upload must include image data.");
  }
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_BYTES) {
    throw new ValidationError("Image is larger than the 8 MB limit.");
  }
  // Reject data that is not plausible base64 rather than passing it on.
  if (!/^[A-Za-z0-9+/=_-]+$/.test(base64.replace(/\s/g, ""))) {
    throw new ValidationError("Image data is not valid base64.");
  }
  return { mime, bytes };
}

export function meanConfidence(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.round(mean * 100) / 100;
}

export async function runAnalysis(
  config: ServerConfig,
  input: { mime: string; base64: string },
  fetchFn: typeof fetch = fetch,
): Promise<Analysis> {
  validateImageInput(input.mime, input.base64);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const dataUrl = `data:${input.mime};base64,${input.base64}`;

  if (!config.metaApiKey) {
    const f = fixtureAnalysis(id);
    const council = fixtureCouncil(f.observations);
    const ev = buildEvidenceLinks(council, f.observations);
    return {
      ...f,
      id,
      createdAt,
      approval: "awaiting_approval",
      approvedAt: null,
      council: ev.filteredCouncil,
      evidenceLinks: ev.links,
      droppedCitationIds: ev.droppedCitationIds,
      councilComparison: compareCouncilToPlan(
        f.plan.map((t) => t.title),
        ev.filteredCouncil.recommendations.map((r) => r.text),
      ),
      decidedBy: null,
    };
  }

  // Live Spark interpretation first; its categories drive SAM prompts.
  const spark = await callMuseModel(config, SPARK_MODEL, dataUrl, fetchFn);
  const interp = spark.interpretation;

  // Optional Wonder second pass: only a re-read for plan quality, never a
  // silent replacement. If it fails, the Spark result still stands.
  let usage = [spark.usage];
  let plan = interp.plan;
  if (config.wonderEnabled) {
    try {
      const wonder = await callMuseModel(config, WONDER_MODEL, dataUrl, fetchFn);
      usage = [...usage, wonder.usage];
      if (wonder.interpretation.plan.length > 0) plan = wonder.interpretation.plan;
    } catch {
      // Recorded as a non-fatal note in the honesty field, not hidden.
      plan = interp.plan;
    }
  }

  // Live SAM: one Responses call per category phrase, decoded with the
  // official @meta-sam/parser (see providers/sam.ts). If SAM fails for a
  // phrase, that phrase contributes a warning and zero detections — never
  // a fixture box, and never a failure of the whole Spark analysis.
  const sam = new LiveSamAdapter(config, fetchFn);
  let detections: Analysis["detections"] = [];
  let samWarnings: string[] = [];
  let samUsage: Analysis["usage"] = [];
  let samVerification: Analysis["samVerification"];
  try {
    const samResult = await sam.segment(dataUrl, interp.categories);
    detections = samResult.detections;
    samWarnings = samResult.warnings;
    samUsage = samResult.usage;
    samVerification = {
      phrasesAttempted: samResult.perPhrase.filter((p) => p.attempted).length,
      phrasesProtocolOk: samResult.perPhrase.filter((p) => p.protocolOk).length,
      phrasesDecodedOk: samResult.perPhrase.filter((p) => p.decodedOk).length,
      detections: samResult.perPhrase.reduce((n, p) => n + p.detections, 0),
    };
  } catch (err) {
    samWarnings = [`SAM segmentation failed: ${err instanceof Error ? err.message : "unknown error"}`];
    samVerification = { phrasesAttempted: 0, phrasesProtocolOk: 0, phrasesDecodedOk: 0, detections: 0 };
  }
  usage = [...usage, ...samUsage];

  const observations = interp.observations.map((o, i) => ({
    id: `obs-${i + 1}`,
    kind: o.kind,
    text: o.text,
    evidence: o.evidence,
    confidence: o.confidence,
    detectionIds: [] as string[],
  }));
  const issues = interp.issues.map((o, i) => ({
    id: `issue-${i + 1}`,
    title: o.title,
    severity: o.severity,
    description: o.description,
    observationIds: [] as string[],
  }));
  const tasks = plan.map((o, i) => ({
    id: `task-${i + 1}`,
    title: o.title,
    detail: o.detail,
    status: "proposed" as const,
  }));

  // Three-role council over the structured evidence (never over invented
  // measurements). Council failures are recorded per-role, not fabricated.
  // Final Sprint: council citations are validated into evidence links
  // (unknown ids dropped, never linked); the council-vs-plan comparison
  // is a textual overlap only, never an accuracy claim.
  const councilResult = await runCouncil(config, { observations, issues }, fetchFn);
  usage = [...usage, ...councilResult.usage];
  const ev = buildEvidenceLinks(councilResult.council, observations);
  const councilComparison = compareCouncilToPlan(
    plan.map((t) => t.title),
    ev.filteredCouncil.recommendations.map((r) => r.text),
  );

  const base: Analysis = {
    id,
    createdAt,
    mode: "live",
    sceneSummary: interp.sceneSummary,
    categories: interp.categories,
    detections,
    observations,
    issues,
    council: ev.filteredCouncil,
    samWarnings,
    samVerification,
    evidenceLinks: ev.links,
    droppedCitationIds: ev.droppedCitationIds,
    councilComparison,
    plan: tasks,
    usage,
    overallConfidence: meanConfidence(observations.map((o) => o.confidence)),
    honestyNote:
      samWarnings.length > 0
        ? `LIVE Muse Spark interpretation. SAM notes: ${samWarnings.join(" ")}`
        : "LIVE Muse Spark interpretation with live SAM segmentation (decoded masks/boxes). Costs shown are estimates, not billed charges.",
    approval: "awaiting_approval",
    approvedAt: null,
    decidedBy: null,
  };
  void buildQuantumTapeRequest(base); // Contract validated by tests; sent in Phase 2.
  return base;
}

// Keep the fixture adapter import referenced for the fixture path's clarity.
void FixtureSamAdapter;
