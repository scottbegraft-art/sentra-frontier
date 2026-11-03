import { estimateCost, type ServerConfig } from "../config.js";
import type { LiveTestResult, SceneInterpretation, Usage } from "../types.js";
import { ProviderError, ValidationError } from "../types.js";

/**
 * Meta Model API adapters (server side only).
 *
 * Muse Spark 1.3 and Muse Wonder 1.0 are called through the documented
 * OpenAI-compatible Chat Completions surface at
 *   POST {META_API_BASE_URL}/chat/completions
 * with `Authorization: Bearer <META_API_KEY>` and an image_url content part
 * for multimodal input. This matches Meta's published compatibility claim
 * and the independent provider docs checked 26 Oct 2026 (see
 * docs/META-API-RESEARCH.md). No key is ever logged or returned.
 *
 * SAM 3.1 is intentionally NOT called here: Meta ships it as a streaming
 * segmentation protocol with client libraries in github.com/meta-models/meta-sam,
 * and no simple REST image endpoint was verified during Phase 1 research.
 * Inventing one would be a fabricated integration, so the SAM adapter lives
 * in sam.ts and refuses live mode until the protocol is verified.
 */

export const SPARK_MODEL = "muse-spark-1.3";
export const WONDER_MODEL = "muse-wonder-1.0";

export const SCENE_PROMPT = `You are analyzing a photo of a manufacturing workstation.
Return ONLY a JSON object (no markdown, no commentary) with this exact shape:
{
  "sceneSummary": "one or two sentences describing what is actually visible",
  "categories": ["up to 6 short object categories worth segmenting, e.g. workbench, tool, storage bin"],
  "observations": [{"kind": "observation" | "assumption", "text": "...", "evidence": "what in the image supports this", "confidence": 0.0-1.0}],
  "issues": [{"title": "...", "severity": "low" | "medium" | "high", "description": "..."}],
  "plan": [{"title": "...", "detail": "..."}]
}
Rules: label anything you infer but cannot see as kind "assumption" with confidence below 0.6.
Never claim a hazard, defect, or measurement you cannot see. If the image is not a workstation, say so in sceneSummary.`;

export interface SparkResult {
  interpretation: SceneInterpretation;
  usage: Usage;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new ProviderError("Model response did not contain a JSON object.");
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new ProviderError("Model response contained malformed JSON.");
  }
}

export function parseSceneInterpretation(raw: unknown): SceneInterpretation {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("Scene interpretation must be an object.");
  }
  const r = raw as Record<string, unknown>;
  const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const isNum01 = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 1;
  if (!isStr(r.sceneSummary) || !Array.isArray(r.categories) || !r.categories.every(isStr)) {
    throw new ValidationError("Scene interpretation is missing sceneSummary or categories.");
  }
  if (!Array.isArray(r.observations) || !r.observations.every((o) => {
    const x = o as Record<string, unknown>;
    return (x.kind === "observation" || x.kind === "assumption") && isStr(x.text) && isStr(x.evidence) && isNum01(x.confidence);
  })) {
    throw new ValidationError("Scene interpretation observations are invalid.");
  }
  if (!Array.isArray(r.issues) || !r.issues.every((o) => {
    const x = o as Record<string, unknown>;
    return isStr(x.title) && ["low", "medium", "high"].includes(String(x.severity)) && isStr(x.description);
  })) {
    throw new ValidationError("Scene interpretation issues are invalid.");
  }
  if (!Array.isArray(r.plan) || !r.plan.every((o) => {
    const x = o as Record<string, unknown>;
    return isStr(x.title) && isStr(x.detail);
  })) {
    throw new ValidationError("Scene interpretation plan is invalid.");
  }
  return raw as SceneInterpretation;
}

/**
 * Genuine connectivity test (Phase 1B, Priority 2). This is a real minimal
 * model request — not key-presence reporting. It sends a text-only prompt
 * ("Reply with the single word OK.") to muse-spark-1.3 and records the
 * model id, HTTP status, latency, token usage when provided, and any error.
 * The key is never included in the result, logged, or returned.
 */
export async function testSparkConnectivity(
  config: ServerConfig,
  fetchFn: typeof fetch = fetch,
): Promise<LiveTestResult> {
  const started = Date.now();
  if (!config.metaApiKey) {
    return {
      at: new Date().toISOString(),
      model: SPARK_MODEL,
      ok: false,
      httpStatus: null,
      latencyMs: Date.now() - started,
      responseText: null,
      promptTokens: null,
      completionTokens: null,
      estimatedCostUsd: null,
      error: "No API key configured (MODEL_API_KEY or META_API_KEY). This is the blocker for live mode; fixture mode is preserved.",
    };
  }
  let response: Response;
  try {
    response = await fetchFn(`${config.metaBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.metaApiKey}`,
      },
      body: JSON.stringify({
        model: SPARK_MODEL,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      at: new Date().toISOString(),
      model: SPARK_MODEL,
      ok: false,
      httpStatus: null,
      latencyMs: Date.now() - started,
      responseText: null,
      promptTokens: null,
      completionTokens: null,
      estimatedCostUsd: null,
      error: `Network/timeout reaching the Meta Model API: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
  const latencyMs = Date.now() - started;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      at: new Date().toISOString(),
      model: SPARK_MODEL,
      ok: false,
      httpStatus: response.status,
      latencyMs,
      responseText: null,
      promptTokens: null,
      completionTokens: null,
      estimatedCostUsd: null,
      error: `Meta Model API returned HTTP ${response.status}. ${body.slice(0, 300)}`,
    };
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = payload.choices?.[0]?.message?.content ?? null;
  const promptTokens = payload.usage?.prompt_tokens ?? null;
  const completionTokens = payload.usage?.completion_tokens ?? null;
  return {
    at: new Date().toISOString(),
    model: SPARK_MODEL,
    ok: true,
    httpStatus: response.status,
    latencyMs,
    responseText: text,
    promptTokens,
    completionTokens,
    estimatedCostUsd: estimateCost(SPARK_MODEL, promptTokens, completionTokens),
    error: null,
  };
}

/** Text-only Muse chat call, used by the reasoning council. Returns raw text. */
export async function callMuseText(
  config: ServerConfig,
  model: typeof SPARK_MODEL | typeof WONDER_MODEL,
  prompt: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ text: string; usage: Usage }> {
  if (!config.metaApiKey) {
    throw new ProviderError("No API key configured; live mode is unavailable.", 503);
  }
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchFn(`${config.metaBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.metaApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(config.modelTimeoutMs),
    });
  } catch (err) {
    throw new ProviderError(`Could not reach the Meta Model API: ${err instanceof Error ? err.message : "network error"}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ProviderError(`Meta Model API returned ${response.status}. ${body.slice(0, 300)}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new ProviderError("Meta Model API returned an empty completion.");
  }
  const promptTokens = payload.usage?.prompt_tokens ?? null;
  const completionTokens = payload.usage?.completion_tokens ?? null;
  return {
    text,
    usage: {
      provider: "meta",
      model,
      mode: "live",
      promptTokens,
      completionTokens,
      costUsd: estimateCost(model, promptTokens, completionTokens),
      latencyMs: Date.now() - started,
    },
  };
}

/** Call a Muse model with an image. `fetchFn` is injectable for tests. */
export async function callMuseModel(
  config: ServerConfig,
  model: typeof SPARK_MODEL | typeof WONDER_MODEL,
  imageDataUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<SparkResult> {
  if (!config.metaApiKey) {
    throw new ProviderError("META_API_KEY is not configured; live mode is unavailable.", 503);
  }
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchFn(`${config.metaBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.metaApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: SCENE_PROMPT },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(config.modelTimeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ProviderError(`Meta Model API timed out after ${config.modelTimeoutMs}ms.`);
    }
    throw new ProviderError(`Could not reach the Meta Model API: ${err instanceof Error ? err.message : "network error"}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ProviderError(
      `Meta Model API returned ${response.status}. ${response.status === 401 ? "Check that META_API_KEY is valid." : body.slice(0, 300)}`,
      response.status === 401 || response.status === 403 ? 502 : 502,
    );
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new ProviderError("Meta Model API returned an empty completion.");
  }
  const interpretation = parseSceneInterpretation(extractJson(content));
  const promptTokens = payload.usage?.prompt_tokens ?? null;
  const completionTokens = payload.usage?.completion_tokens ?? null;
  return {
    interpretation,
    usage: {
      provider: "meta",
      model,
      mode: "live",
      promptTokens,
      completionTokens,
      costUsd: estimateCost(model, promptTokens, completionTokens),
      latencyMs: Date.now() - started,
    },
  };
}
