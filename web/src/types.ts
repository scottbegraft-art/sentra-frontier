export interface Detection {
  id: string;
  label: string;
  category: string;
  box: { x: number; y: number; width: number; height: number };
  confidence: number | null;
  maskAvailable: boolean;
  maskSvgPath?: string;
  maskRasterWidth?: number;
  maskRasterHeight?: number;
  source?: "live" | "fixture";
}
export interface Observation {
  id: string;
  kind: "observation" | "assumption";
  text: string;
  evidence: string;
  confidence: number;
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
  status: "proposed" | "approved" | "rejected";
}
export interface Usage {
  provider: string;
  model: string;
  mode: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
}
export interface CouncilRole {
  role: "analyst" | "critic" | "planner";
  position: string;
  points: string[];
  evidenceObservationIds: string[];
  error: string | null;
}
export interface Council {
  mode: string;
  analyst: CouncilRole;
  critic: CouncilRole;
  planner: CouncilRole;
  disagreements: string[];
  openQuestions: string[];
  recommendations: Array<{ id: string; text: string; observationIds: string[] }>;
}
export interface EvidenceLink {
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  basis: string;
  citedText?: string;
  createdAt: string;
  createdBy: string;
}
export interface CalculatorResult {
  inputs: { currentMinutesPerUnit: number; proposedMinutesPerUnit: number; unitsPerDay: number; laborCostPerHourUsd: number; workingDays: number };
  timeSavedPerUnitMinutes: number;
  unitsPerHourBefore: number;
  unitsPerHourAfter: number;
  productivityChangePercent: number;
  timeSavedPerDayHours: number;
  timeSavedPerPeriodHours: number;
  laborHourValueUsd: number;
  formulas: string[];
  assumptions: string[];
  disclaimer: string;
}
export interface Analysis {
  id: string;
  createdAt: string;
  mode: "live" | "fixture";
  sceneSummary: string;
  categories: string[];
  detections: Detection[];
  observations: Observation[];
  issues: Issue[];
  plan: PlanTask[];
  usage: Usage[];
  overallConfidence: number;
  honestyNote: string;
  approval: "awaiting_approval" | "approved" | "rejected";
  approvedAt: string | null;
  council: Council | null;
  samWarnings: string[];
  decidedBy: string | null;
  evidenceLinks: EvidenceLink[];
  droppedCitationIds: string[];
  councilComparison?: {
    singleModelPlanTitles: string[];
    councilRecommendationTexts: string[];
    shared: string[];
    councilOnly: string[];
    planOnly: string[];
    note: string;
  };
  samVerification?: { phrasesAttempted: number; phrasesProtocolOk: number; phrasesDecodedOk: number; detections: number };
}
export interface AuditEvent {
  at: string;
  analysisId: string;
  event: string;
  detail: string;
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
  estimatedCostUsd: number | null;
  error: string | null;
}
export interface MetaStatus {
  keyConfigured: boolean;
  keySource: string | null;
  baseUrl: string;
  mode: string;
  spark: { model: string; liveTested: boolean; lastCheck: string | null; error: string | null };
  sam: { model: string; liveVerified: boolean; note: string };
  wonder: { model: string; enabled: boolean; note: string };
  approvalAuth: "token" | "open";
  sparkConnectedAt: string | null;
  sparkImageAt: string | null;
  samVerifiedAt: string | null;
  samLastDetections: number | null;
  lastFailure: string | null;
  lastWarning: string | null;
  billableAccess: "localhost-only" | "token-required" | "misconfigured";
  bindHost: string;
  lastLiveTest: LiveTestResult | null;
}
