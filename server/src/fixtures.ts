import type { Analysis, Detection, Issue, Observation, PlanTask } from "./types.js";

/**
 * FIXTURE — clearly labeled, deterministic placeholder data.
 *
 * This is NOT a Meta model result. It exists so the full workflow
 * (upload -> categories -> overlays -> observations -> plan -> approval ->
 * audit) can be exercised end to end before a Meta Model API key is
 * configured. Every fixture observation is marked as an assumption or is
 * explicitly tied to a generic fixture box, and the UI badges the whole
 * analysis "FIXTURE MODE". Do not remove those labels.
 */
export const FIXTURE_CATEGORIES = [
  "workbench",
  "tool",
  "storage bin",
  "safety equipment",
  "cable",
];

export function fixtureDetections(): Detection[] {
  return [
    {
      id: "det-workbench",
      label: "Workbench (fixture box)",
      category: "workbench",
      box: { x: 0.08, y: 0.35, width: 0.84, height: 0.45 },
      confidence: 0.5,
      maskAvailable: false,
    },
    {
      id: "det-tool",
      label: "Tool (fixture box)",
      category: "tool",
      box: { x: 0.2, y: 0.42, width: 0.18, height: 0.16 },
      confidence: 0.5,
      maskAvailable: false,
    },
    {
      id: "det-bin",
      label: "Storage bin (fixture box)",
      category: "storage bin",
      box: { x: 0.68, y: 0.3, width: 0.2, height: 0.28 },
      confidence: 0.5,
      maskAvailable: false,
    },
  ];
}

export function fixtureAnalysis(id: string): Omit<Analysis, "id" | "createdAt" | "approval" | "approvedAt" | "decidedBy"> {
  // Release-candidate fix (2 Nov 2026): fixture detections must carry
  // source: "fixture" like the FixtureSamAdapter does, so a judge
  // inspecting JSON can never mistake a placeholder box for a live SAM
  // detection (live detections carry source: "live").
  const detections = fixtureDetections().map((d) => ({ ...d, source: "fixture" as const }));
  const observations: Observation[] = [
    {
      id: "obs-1",
      kind: "observation",
      text: "A fixture overlay was drawn over the uploaded image. Its boxes are placeholders, not detections of objects in this specific photo.",
      evidence: "Fixture mode is active (no Meta API key configured); boxes are fixed relative coordinates.",
      confidence: 0.5,
      // Final Sprint: no validated detection link, even in fixture mode.
      // Placeholder boxes are not evidence for this observation, so the
      // association is UNLINKED, not implied by the template.
      detectionIds: [],
    },
    {
      id: "obs-2",
      kind: "assumption",
      text: "In a live run, this is where a workstation-layout, clutter, or safety observation would appear, each tied to a named detection.",
      evidence: "No live model output exists for this upload; this entry is a template assumption, not evidence from the photo.",
      confidence: 0.3,
      detectionIds: [],
    },
  ];
  const issues: Issue[] = [
    {
      id: "issue-1",
      title: "Fixture data cannot support a real operational finding",
      severity: "medium",
      description:
        "Because no live model analyzed this photo, no genuine operational problem can be claimed from it. Configure a Meta API key and re-run for a real assessment.",
      observationIds: ["obs-1"],
    },
  ];
  const plan: PlanTask[] = [
    {
      id: "task-1",
      title: "Configure the Meta Model API key and re-run this photo",
      detail: "Set MODEL_API_KEY server-side (never in chat or client code), re-upload the same workstation photo, and compare the live scene interpretation against this fixture structure.",
      status: "proposed",
    },
    {
      id: "task-2",
      title: "Run the first live SAM call to verify segmentation",
      detail: "With a key configured, run a live analysis: one SAM Responses call per phrase, decoded with @meta-sam/parser. If the model id sam-3.1 is rejected, record the HTTP error — do not silently fall back to fixture masks.",
      status: "proposed",
    },
  ];
  return {
    mode: "fixture",
    sceneSummary:
      "FIXTURE — placeholder scene description. No Meta model has interpreted this image.",
    categories: FIXTURE_CATEGORIES,
    detections,
    observations,
    issues,
    council: null, // Filled by analysis.ts with fixtureCouncil so the shape is complete.
    samWarnings: [],
    // Filled by analysis.ts with buildEvidenceLinks; empty here so the
    // fixture template itself claims no links.
    evidenceLinks: [],
    droppedCitationIds: [],
    plan,
    usage: [
      {
        provider: "fixture",
        model: "fixture",
        mode: "fixture",
        promptTokens: null,
        completionTokens: null,
        costUsd: 0,
        latencyMs: 0,
      },
    ],
    overallConfidence: 0.4,
    honestyNote:
      "FIXTURE MODE: structure, overlays, plan and approval flow are real; scene content is placeholder. No Meta API call was made.",
  };
}
