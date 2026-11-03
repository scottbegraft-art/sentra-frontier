/** Shared domain types for Sentra Frontier (server side). */

export type ProviderMode = "live" | "fixture";

export type ObservationKind = "observation" | "assumption";

export interface BoundingBox {
  /** All coordinates are fractions of image width/height, 0..1. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Detection {
  id: string;
  label: string;
  /** SAM prompt category that produced this detection. */
  category: string;
  box: BoundingBox;
  /** 0..1, or null when the provider gave no confidence (absence != zero). */
  confidence: number | null;
  /** True when a decoded mask SVG is attached (live SAM) or a fixture mask exists. */
  maskAvailable: boolean;
  /** Decoded mask SVG path in raster-local coordinates, when available. */
  maskSvgPath?: string;
  maskRasterWidth?: number;
  maskRasterHeight?: number;
  /** Where this detection came from: live SAM, fixture, or a live SAM box with no mask. */
  source?: "live" | "fixture";
}

export interface CouncilRole {
  role: "analyst" | "critic" | "planner";
  position: string;
  points: string[];
  /** Observation ids this role cites. Empty when the role cites none. */
  evidenceObservationIds: string[];
  /** Non-null when this role's live call failed; its points are then absent, never fabricated. */
  error: string | null;
}

export interface Council {
  mode: ProviderMode;
  analyst: CouncilRole;
  critic: CouncilRole;
  planner: CouncilRole;
  /** Points where roles disagree, derived from critic + planner input. */
  disagreements: string[];
  /** Questions only the user / on-site check can answer. */
  openQuestions: string[];
  /** Final recommendations, each tied to validated observation ids (or none, when ungrounded). */
  recommendations: Array<{ id: string; text: string; observationIds: string[] }>;
}

/** A validated evidence link (Final Sprint). No link exists without a recorded basis. */
export interface EvidenceLink {
  id: string;
  fromType: "recommendation" | "observation" | "issue";
  fromId: string;
  toType: "observation" | "detection";
  toId: string;
  basis: "pipeline" | "council-citation" | "user-confirmed";
  /** For council citations: the linked observation's own text, so relevance is checkable. */
  citedText?: string;
  createdAt: string;
  createdBy: string;
}

export interface Observation {
  id: string;
  kind: ObservationKind;
  text: string;
  /** What in the image / detection list supports this — never invented detail. */
  evidence: string;
  confidence: number;
  /** Detection ids this observation rests on, if any. */
  detectionIds: string[];
}

export interface Issue {
  id: string;
  title: string;
  severity: "low" | "medium" | "high";
  description: string;
  observationIds: string[];
}

export interface PlanTask {
  id: string;
  title: string;
  detail: string;
  /** Tasks are PROPOSED only until a user approves them. */
  status: "proposed" | "approved" | "rejected";
}

export interface Usage {
  provider: string;
  model: string;
  mode: ProviderMode;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Actual billed estimate in USD, when the provider reported usage. Fixture = 0. */
  costUsd: number | null;
  latencyMs: number;
}

export interface Analysis {
  id: string;
  createdAt: string;
  mode: ProviderMode;
  sceneSummary: string;
  categories: string[];
  detections: Detection[];
  observations: Observation[];
  issues: Issue[];
  plan: PlanTask[];
  usage: Usage[];
  /** Overall confidence is the mean of observation confidences, not a benchmark. */
  overallConfidence: number;
  /** Human-readable honesty note shown in the UI. */
  honestyNote: string;
  /** Approval gate state. Nothing is "executed" before approval. */
  approval: "awaiting_approval" | "approved" | "rejected";
  approvedAt: string | null;
  /** Three-role council (Phase 1B). Null only for analyses created before 1B. */
  council: Council | null;
  /** Per-phrase SAM notes, including zero-match results and SAM errors. */
  samWarnings: string[];
  /**
   * SAM verification breakdown (Phase 1D, live analyses only).
   * attempted = Responses calls made; protocolOk = HTTP 200 received;
   * decodedOk = response successfully interpreted (detections, or a
   * valid completed zero-match). Only decodedOk > 0 marks SAM verified.
   */
  samVerification?: {
    phrasesAttempted: number;
    phrasesProtocolOk: number;
    phrasesDecodedOk: number;
    detections: number;
  };
  /**
   * Validated evidence links (Final Sprint). A link exists ONLY when its
   * provenance is validated (see evidence.ts). Observation→detection
   * links are currently absent by design — observations come from Spark
   * text, not from SAM detections — and are reported as UNLINKED, never
   * inferred from matching labels.
   */
  evidenceLinks: EvidenceLink[];
  /** Observation ids cited by the council that did not exist (dropped, never linked). */
  droppedCitationIds: string[];
  /**
   * Textual comparison between the single-model plan and the council's
   * recommendations (Final Sprint). This is a text-overlap comparison
   * only — it is NOT an accuracy ranking and claims no improvement.
   */
  councilComparison?: {
    singleModelPlanTitles: string[];
    councilRecommendationTexts: string[];
    shared: string[];
    councilOnly: string[];
    planOnly: string[];
    note: string;
  };
  /** Who approved/rejected, when known (demo: "demo-user" unless a token identity is set). */
  decidedBy: string | null;
}

export interface AuditEvent {
  at: string;
  analysisId: string;
  event: "analysis_created" | "tasks_approved" | "tasks_rejected" | "analysis_viewed";
  detail: string;
}

export interface MetaStatus {
  keyConfigured: boolean;
  /** Env var that supplied the key, named only (never the value): MODEL_API_KEY or META_API_KEY. */
  keySource: string | null;
  baseUrl: string;
  mode: ProviderMode;
  spark: { model: string; liveTested: boolean; lastCheck: string | null; error: string | null };
  sam: { model: string; liveVerified: boolean; note: string };
  wonder: { model: string; enabled: boolean; note: string };
  /** Approval protection: "token" when FRONTIER_APPROVAL_TOKEN is set, else "open". */
  approvalAuth: "token" | "open";
  /** Last genuine connectivity test, if one has run in this server session. */
  lastLiveTest: LiveTestResult | null;
  /** Genuine verification timestamps — null until a real request succeeds. Key presence never sets these. */
  sparkConnectedAt: string | null;
  sparkImageAt: string | null;
  samVerifiedAt: string | null;
  samLastDetections: number | null;
  lastFailure: string | null;
  lastWarning: string | null;
  /** Billable-endpoint access mode. */
  billableAccess: "localhost-only" | "token-required" | "misconfigured";
  /** Interface the API is bound to (loopback by default). */
  bindHost: string;
}

export interface LiveTestResult {
  at: string;
  model: string;
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  responseText: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Cost estimate in USD, or null when usage was not reported. Never a billed charge. */
  estimatedCostUsd: number | null;
  error: string | null;
}

/** Structured scene result a multimodal model is asked to return as JSON. */
export interface SceneInterpretation {
  sceneSummary: string;
  categories: string[];
  observations: Array<{
    kind: ObservationKind;
    text: string;
    evidence: string;
    confidence: number;
  }>;
  issues: Array<{
    title: string;
    severity: Issue["severity"];
    description: string;
  }>;
  plan: Array<{ title: string; detail: string }>;
}

export class ProviderError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "ProviderError";
    this.statusCode = statusCode;
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
