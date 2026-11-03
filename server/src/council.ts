import type { ServerConfig } from "./config.js";
import { callMuseText, SPARK_MODEL } from "./providers/meta.js";
import type { Analysis, Council, CouncilRole, Observation } from "./types.js";
import { ProviderError } from "./types.js";

/**
 * Three-role reasoning council (Phase 1B, Priority 4).
 *
 * Roles run as DISTINCT prompts through Muse Spark in live mode:
 *   analyst  — identifies potential improvements from the evidence;
 *   critic   — challenges assumptions and unsupported conclusions;
 *   planner  — proposes feasible actions and names missing evidence.
 * Input is the structured observations/issues from the scene step — never
 * invented physical measurements. A role whose live call fails records
 * error and contributes no points; it is never filled in with fabricated
 * text. Disagreements and open questions are derived from the critic's
 * output (live) or from the fixture template (fixture mode).
 *
 * Quantum Tape is NOT called here. The versioned QuantumTapeRequest
 * contract in analysis.ts stays intact for a future, separately authorized
 * bridge; this local council is the Master Plan's Phase 1 fallback.
 */

function evidenceText(observations: Observation[], issues: Analysis["issues"]): string {
  const obs = observations
    .map((o) => `- [${o.id}] (${o.kind}, confidence ${o.confidence}) ${o.text} | evidence: ${o.evidence}`)
    .join("\n");
  const iss = issues.map((i) => `- [${i.id}] (${i.severity}) ${i.title}: ${i.description}`).join("\n");
  return `OBSERVATIONS:\n${obs || "(none)"}\n\nISSUES:\n${iss || "(none)"}`;
}

function rolePrompt(role: "analyst" | "critic" | "planner", evidence: string): string {
  const base = `You are reviewing a warehouse packing workstation analysis. Use ONLY the evidence below. Do not invent measurements, hazards, or facts not in the evidence. Return ONLY a JSON object: {"position": "one sentence", "points": ["..."], "evidenceObservationIds": ["obs-..."], "openQuestions": ["..."]}.\n\n${evidence}\n\n`;
  if (role === "analyst") {
    return base + `Role: Operations Analyst. Identify potential improvements supported by the evidence. Mark anything inferred as an inference in the point text.`;
  }
  if (role === "critic") {
    return base + `Role: Critical Reviewer. Challenge assumptions and unsupported conclusions in the evidence. List every conclusion you find weakly supported, and what would verify it.`;
  }
  return base + `Role: Implementation Planner. Propose feasible actions only. For each point, say what evidence is still missing before it can be done safely.`;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in council response.");
  return JSON.parse(candidate.slice(start, end + 1));
}

function parseRole(role: CouncilRole["role"], raw: unknown): CouncilRole {
  if (typeof raw !== "object" || raw === null) throw new Error("Council role response was not an object.");
  const r = raw as Record<string, unknown>;
  if (typeof r.position !== "string" || !Array.isArray(r.points) || !r.points.every((p) => typeof p === "string")) {
    throw new Error("Council role response is missing position or points.");
  }
  const ids = Array.isArray(r.evidenceObservationIds)
    ? r.evidenceObservationIds.filter((x): x is string => typeof x === "string")
    : [];
  return {
    role,
    position: r.position,
    points: r.points as string[],
    evidenceObservationIds: ids,
    error: null,
  };
}

export function fixtureCouncil(observations: Observation[]): Council {
  const analyst: CouncilRole = {
    role: "analyst",
    position: "FIXTURE — no live council ran; this is a template reading of the fixture observations.",
    points: [
      "Fixture structure is in place, but no real workstation evidence exists yet — do not act on fixture findings.",
      "Re-run with a Meta API key to get analyst points grounded in a real photo.",
    ],
    evidenceObservationIds: observations.map((o) => o.id),
    error: null,
  };
  const critic: CouncilRole = {
    role: "critic",
    position: "FIXTURE — the critic's job here is to block any unsupported certainty from fixture data.",
    points: [
      "Every fixture observation is placeholder data, not evidence from the uploaded photo.",
      "No measurement, hazard, or savings claim in this run is supported.",
    ],
    evidenceObservationIds: observations.map((o) => o.id),
    error: null,
  };
  const planner: CouncilRole = {
    role: "planner",
    position: "FIXTURE — the only defensible plan step is to obtain real evidence.",
    points: ["Configure MODEL_API_KEY server-side and re-run this photo with live Muse Spark and SAM."],
    evidenceObservationIds: [],
    error: null,
  };
  return {
    mode: "fixture",
    analyst,
    critic,
    planner,
    disagreements: [
      "Analyst template vs critic template: the analyst points describe a workflow, while the critic points out the workflow has no real evidence — the critic prevails in fixture mode.",
    ],
    openQuestions: [
      "What does the real workstation photo actually show? (Requires a live run.)",
      "Which objects did SAM actually detect, if any? (Requires a live SAM run.)",
    ],
    recommendations: [
      { id: "rec-1", text: "Configure a Meta API key and re-run this photo live before approving any operational change.", observationIds: observations.map((o) => o.id) },
    ],
  };
}

export async function runCouncil(
  config: ServerConfig,
  analysis: Pick<Analysis, "observations" | "issues">,
  fetchFn: typeof fetch = fetch,
): Promise<{ council: Council; usage: Analysis["usage"] }> {
  if (!config.metaApiKey) {
    return { council: fixtureCouncil(analysis.observations), usage: [] };
  }
  const evidence = evidenceText(analysis.observations, analysis.issues);
  const roles: Array<"analyst" | "critic" | "planner"> = ["analyst", "critic", "planner"];
  const results: CouncilRole[] = [];
  const usage: Analysis["usage"] = [];
  const openQuestions: string[] = [];
  for (const role of roles) {
    try {
      const { text, usage: u } = await callMuseText(config, SPARK_MODEL, rolePrompt(role, evidence), fetchFn);
      usage.push(u);
      const raw = extractJson(text);
      const parsed = parseRole(role, raw);
      results.push(parsed);
      if (typeof raw === "object" && raw !== null) {
        const questions = (raw as Record<string, unknown>).openQuestions;
        if (Array.isArray(questions)) {
          for (const q of questions) if (typeof q === "string") openQuestions.push(q);
        }
      }
    } catch (err) {
      results.push({
        role,
        position: "Role call failed — no points were generated for this role.",
        points: [],
        evidenceObservationIds: [],
        error: err instanceof Error ? err.message : "council role call failed",
      });
    }
  }
  const [analyst, critic, planner] = results as [CouncilRole, CouncilRole, CouncilRole];
  const disagreements = critic.points.length > 0
    ? critic.points.map((p) => `Critic challenge: ${p}`)
    : ["Critic role produced no challenges (call failed or returned none) — disagreement trace is incomplete, not clean."];
  const recommendations = planner.points.map((p, i) => ({
    id: `rec-${i + 1}`,
    text: p,
    observationIds: planner.evidenceObservationIds,
  }));
  return {
    council: {
      mode: "live",
      analyst,
      critic,
      planner,
      disagreements,
      openQuestions,
      recommendations,
    },
    usage,
  };
}

void ProviderError;
