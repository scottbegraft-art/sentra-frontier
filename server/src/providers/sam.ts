import {
  decodeMaskToSVGPath,
  parseImageStream,
  recordsOfKind,
  type ResponsesEvent,
} from "@meta-sam/parser";
import { PRICES, SAM_MODEL, type ServerConfig } from "../config.js";
import type { Detection, Usage } from "../types.js";
import { ProviderError } from "../types.js";
import { fixtureDetections } from "../fixtures.js";

/**
 * SAM 3.1 adapter (Phase 1B).
 *
 * Live path — documented shape, per the official @meta-sam/parser package
 * (v0.1.0) and the SAM Responses API:
 *   POST {base}/responses, model "sam-3.1", stream: true,
 *   input: one message with input_text = ONE short noun phrase and
 *   input_image = the photo as a data URL, metadata.include_confidence = "true".
 * The response is special-token text in one output_text lane
 * (`<0f>id<|box;...|><|mask;...|>`), NOT ordinary JSON. It is decoded with
 * parseImageStream + recordsOfKind + decodeMaskToSVGPath — never hand-rolled
 * mask math. One call per phrase. A phrase with no records is a genuine
 * zero-match: it returns zero detections and a warning, never a fake box.
 *
 * Model-id note: "sam-3.1" is the API id, confirmed from Meta's official
 * docs in Phase 1B (some prose uses "sam-3-1"; that is not the API id).
 * If a live call rejects the id, the recorded HTTP error — not a silent
 * fallback — is the signal to correct it.
 *
 * What is still unverified: no live SAM call has been made from this
 * project (no key configured). The live code path is unit-tested against
 * a recorded-format stream, but live verification is pending a key.
 */

/**
 * Per-phrase SAM outcome (Phase 1D). The four stages are kept separate
 * so they can never be conflated into a false verification:
 *  - attempted: a Responses call was made for this phrase.
 *  - protocolOk: an HTTP 200 response was received (a protocol success).
 *  - decodedOk: the response was successfully interpreted as SAM
 *    segmentation — at least one decoded detection, OR a valid
 *    completed empty output (a genuine zero-match).
 *  - usage: estimated cost for a protocol-successful call, recorded
 *    regardless of decoding, because the call may still have been
 *    billed. Usage alone never implies verification.
 */
export interface SamPhraseOutcome {
  phrase: string;
  attempted: boolean;
  protocolOk: boolean;
  decodedOk: boolean;
  detections: number;
}

export interface SamSegmentResult {
  detections: Detection[];
  warnings: string[];
  usage: Usage[];
  perPhrase: SamPhraseOutcome[];
}

function extractFrameSize(rawOutput: string): { w: number; h: number } | null {
  const m = rawOutput.match(/w=(\d+);h=(\d+)/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
}

/**
 * Extract output text from a Responses SSE body, a JSON response, or raw text.
 *
 * Phase 1C fix (Priority 4): streamed `response.output_text.delta`
 * content must NOT be duplicated when a final event also carries the
 * assembled output. Rules, in priority order:
 *   1. An `output_text.done` event's `text` is the complete output — return it alone.
 *   2. Otherwise a `response.completed` event's assembled output — return it alone.
 *   3. Otherwise concatenate `delta` events only.
 * Unknown event types, malformed data lines, and out-of-order events
 * (done before deltas, completed without output) are ignored, never
 * guessed at. An empty result is a valid zero-match outcome, not an error.
 */
export function extractSamOutputText(bodyText: string): string {
  const deltas: string[] = [];
  let doneText: string | null = null;
  let completedText: string | null = null;
  let sawSse = false;
  for (const line of bodyText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    sawSse = true;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const ev = JSON.parse(data) as {
        type?: string;
        delta?: string;
        text?: string;
        response?: { output?: Array<{ content?: Array<{ text?: string }> }> };
      };
      const assembledFromResponse = ev.response?.output
        ? ev.response.output.flatMap((i) => (i.content ?? []).map((c) => c.text ?? "")).join("")
        : "";
      if (ev.type === "response.output_text.done" && typeof ev.text === "string") {
        doneText = ev.text;
      } else if (ev.type === "response.completed") {
        if (assembledFromResponse) completedText = assembledFromResponse;
        else if (typeof ev.text === "string") completedText = ev.text;
      } else if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
        deltas.push(ev.delta);
      }
      // Any other event type (reasoning, annotations, unknown) is ignored.
    } catch {
      // A non-JSON data line is not SAM output; ignore it rather than guessing.
    }
  }
  if (sawSse) {
    if (doneText !== null) return doneText;
    if (completedText !== null) return completedText;
    return deltas.join("");
  }
  try {
    const parsed = JSON.parse(bodyText) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    if (typeof parsed.output_text === "string") return parsed.output_text;
    if (parsed.output) {
      return parsed.output.flatMap((i) => (i.content ?? []).map((c) => c.text ?? "")).join("");
    }
  } catch {
    // Fall through: treat the body itself as SAM output text.
  }
  return bodyText;
}

/** Decode one SAM output-text stream into detections for a single phrase. */
export async function decodeSamOutput(
  outputText: string,
  phrase: string,
  indexBase: number,
): Promise<{ detections: Detection[]; warnings: string[]; rawOutput: string }> {
  async function* events(): AsyncIterable<ResponsesEvent> {
    yield {
      type: "response.output_text.delta",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      delta: outputText,
    } as ResponsesEvent;
    yield {
      type: "response.output_text.done",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      text: outputText,
    } as ResponsesEvent;
    yield { type: "response.completed" } as ResponsesEvent;
  }
  const result = await parseImageStream(events()).finalResult;
  const warnings: string[] = [];
  for (const d of result.diagnostics) {
    warnings.push(`SAM parser ${d.severity} (${d.code}): ${d.message}`);
  }
  if (result.outcome.status !== "completed") {
    warnings.push(`SAM stream outcome: ${JSON.stringify(result.outcome)}`);
  }
  const boxes = recordsOfKind(result.records, "box");
  const masks = recordsOfKind(result.records, "mask");
  const maskById = new Map(masks.map((m) => [m.objectId, m]));
  const frame = extractFrameSize(result.rawOutput);
  if (boxes.length > 0 && !frame) {
    warnings.push("SAM returned boxes but no frame size (w/h) — boxes cannot be scaled to fractions, so they were dropped rather than guessed.");
    return { detections: [], warnings, rawOutput: result.rawOutput };
  }
  const detections: Detection[] = [];
  boxes.forEach((box, i) => {
    if (!frame) return;
    const mask = maskById.get(box.objectId);
    detections.push({
      id: `det-${indexBase + i}`,
      label: `${phrase} (SAM ${box.objectId})`,
      category: phrase,
      box: {
        x: box.left / frame.w,
        y: box.top / frame.h,
        width: (box.right - box.left) / frame.w,
        height: (box.bottom - box.top) / frame.h,
      },
      // Absent confidence is null, never zero.
      confidence: box.confidence ?? mask?.confidence ?? null,
      maskAvailable: Boolean(mask),
      maskSvgPath: mask ? decodeMaskToSVGPath(mask.mask) : undefined,
      maskRasterWidth: mask ? mask.mask.width : undefined,
      maskRasterHeight: mask ? mask.mask.height : undefined,
      source: "live",
    });
  });
  return { detections, warnings, rawOutput: result.rawOutput };
}

export class FixtureSamAdapter {
  async segment(_imageDataUrl: string, categories: string[]): Promise<SamSegmentResult> {
    const all = fixtureDetections();
    const wanted = new Set(categories.map((c) => c.toLowerCase()));
    const kept = all.filter((d) => wanted.has(d.category.toLowerCase()));
    const detections = (kept.length > 0 ? kept : all).map((d) => ({ ...d, source: "fixture" as const }));
    return {
      detections,
      warnings: [],
      // Fixture data is not a protocol response and not a decoded live
      // result; perPhrase honestly records that, so fixture data can
      // never be mistaken for SAM verification.
      perPhrase: categories.map((phrase) => ({
        phrase,
        attempted: true,
        protocolOk: false,
        decodedOk: false,
        detections: 0,
      })),
      usage: [
        {
          provider: "fixture",
          model: SAM_MODEL,
          mode: "fixture",
          promptTokens: null,
          completionTokens: null,
          costUsd: 0,
          latencyMs: 0,
        },
      ],
    };
  }
}

export class LiveSamAdapter {
  constructor(
    private readonly config: ServerConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** One Responses call per phrase; returns detections + warnings + usage + per-phrase outcomes. */
  async segment(imageDataUrl: string, categories: string[]): Promise<SamSegmentResult> {
    if (!this.config.metaApiKey) {
      throw new ProviderError("No API key configured; live SAM is unavailable.", 503);
    }
    const detections: Detection[] = [];
    const warnings: string[] = [];
    const usage: Usage[] = [];
    const perPhrase: SamPhraseOutcome[] = [];
    let counter = 1;
    for (const phrase of categories) {
      const started = Date.now();
      let response: Response;
      try {
        response = await this.fetchFn(`${this.config.metaBaseUrl}/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.metaApiKey}`,
          },
          body: JSON.stringify({
            model: SAM_MODEL,
            stream: true,
            metadata: { include_confidence: "true" },
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_text", text: phrase },
                  { type: "input_image", image_url: imageDataUrl },
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(this.config.modelTimeoutMs),
        });
      } catch (err) {
        warnings.push(
          `SAM call for "${phrase}" failed before a response: ${err instanceof Error ? err.message : "network error"}. No detections were invented for this phrase.`,
        );
        perPhrase.push({ phrase, attempted: true, protocolOk: false, decodedOk: false, detections: 0 });
        continue;
      }
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        warnings.push(`SAM call for "${phrase}" returned HTTP ${response.status}: ${body.slice(0, 300)}`);
        perPhrase.push({ phrase, attempted: true, protocolOk: false, decodedOk: false, detections: 0 });
        continue;
      }
      // Protocol success: the call was made and may have been billed, so
      // its estimated usage is recorded even if decoding below fails.
      // Usage alone is NOT verification (see decodedOk below).
      usage.push({
        provider: "meta",
        model: SAM_MODEL,
        mode: "live",
        promptTokens: null,
        completionTokens: null,
        costUsd: PRICES.samPerImage,
        latencyMs,
      });
      const bodyText = await response.text();
      const outputText = extractSamOutputText(bodyText);
      let decodedOk = false;
      try {
        const decoded = await decodeSamOutput(outputText, phrase, counter);
        counter += decoded.detections.length;
        detections.push(...decoded.detections);
        warnings.push(...decoded.warnings.map((w) => `"${phrase}": ${w}`));
        if (outputText.trim() === "") {
          // Valid COMPLETED empty output = genuine zero-match. An empty
          // body with no completion marker could instead be a truncated
          // stream, so it does not count — completion must be evidenced
          // by a done/completed event or an explicit empty output_text.
          const completedEvidence =
            bodyText.includes("response.completed") ||
            bodyText.includes("output_text.done") ||
            bodyText.includes('"output_text":""');
          if (completedEvidence) {
            decodedOk = true;
            warnings.push(`SAM returned zero matches for "${phrase}" — shown as no detection, not a placeholder box.`);
          } else {
            decodedOk = false;
            warnings.push(`SAM response for "${phrase}" ended with empty output and no completion marker — treated as truncated/undecodable, not a zero-match. Not counted as verified.`);
          }
        } else if (decoded.detections.length > 0) {
          decodedOk = true;
        } else {
          // Non-empty output that yielded no detections and no parser
          // records is undecodable, not a zero-match. Malformed,
          // truncated, or otherwise uninterpretable output must not
          // produce a false verification status.
          decodedOk = false;
          if (decoded.warnings.length === 0) {
            warnings.push(`SAM output for "${phrase}" could not be interpreted as segmentation (non-empty output, no detections decoded). Not counted as verified.`);
          }
        }
        perPhrase.push({ phrase, attempted: true, protocolOk: true, decodedOk, detections: decoded.detections.length });
      } catch (err) {
        warnings.push(`SAM output for "${phrase}" could not be decoded: ${err instanceof Error ? err.message : "parser error"}`);
        perPhrase.push({ phrase, attempted: true, protocolOk: true, decodedOk: false, detections: 0 });
      }
    }
    return { detections, warnings, usage, perPhrase };
  }
}
