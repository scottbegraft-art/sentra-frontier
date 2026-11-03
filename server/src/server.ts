import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAnalysis, validateImageInput } from "./analysis.js";
import { decideBillableAccess } from "./billable.js";
import { calculateImprovement } from "./calculator.js";
import { loadConfig, loadDotEnv, SAM_MODEL } from "./config.js";
import { SPARK_MODEL, testSparkConnectivity, WONDER_MODEL } from "./providers/meta.js";
import { RateLimiter } from "./rateLimit.js";
import { Store } from "./store.js";
import type { LiveTestResult, MetaStatus } from "./types.js";
import { ProviderError, ValidationError } from "./types.js";
import {
  emptyVerification,
  loadVerification,
  saveVerification,
  type VerificationState,
} from "./verification.js";

// Phase 1C: load a local .env file (if present) BEFORE reading config,
// so `npm run server:start` works with or without a .env file. Existing
// environment variables always win over .env values. No value is logged.
loadDotEnv();
const config = loadConfig();
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = config.dataDir ?? path.join(here, "..", "data");
const store = new Store(dataDir);
let lastLiveTest: LiveTestResult | null = null;
let verification: VerificationState = emptyVerification();
const billableLimiter = new RateLimiter(config.billableRateLimitPerMinute);

async function readJson(req: IncomingMessage, maxBytes = 12 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new ValidationError("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) throw new ValidationError("Request body is empty.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("Request body is not valid JSON.");
  }
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function metaStatus(): MetaStatus {
  return {
    keyConfigured: Boolean(config.metaApiKey),
    keySource: config.metaApiKeySource,
    baseUrl: config.metaBaseUrl,
    mode: config.metaApiKey ? "live" : "fixture",
    spark: {
      model: SPARK_MODEL,
      // Genuine verification only: a configured key never counts as tested.
      liveTested: verification.sparkConnectedAt !== null,
      // lastCheck means last SUCCESSFUL check; the full test history
      // (including blockers) is in lastLiveTest below.
      lastCheck: verification.sparkConnectedAt,
      error: config.metaApiKey
        ? verification.lastFailure
        : "No API key configured (MODEL_API_KEY or META_API_KEY). Server is in fixture mode; no Meta API call has been made.",
    },
    sam: {
      model: SAM_MODEL,
      liveVerified: verification.samAt !== null,
      note: "Live SAM uses POST /v1/responses (streaming) + @meta-sam/parser decoding. One call per noun phrase; zero matches return no detections. liveVerified becomes true only after a successful live SAM call.",
    },
    wonder: {
      model: WONDER_MODEL,
      enabled: config.wonderEnabled && Boolean(config.metaApiKey),
      note: config.wonderEnabled
        ? "Wonder second pass is enabled when a key is configured."
        : "Wonder is off by default; it is the optional, higher-cost reasoning pass.",
    },
    approvalAuth: config.approvalToken ? "token" : "open",
    lastLiveTest,
    sparkConnectedAt: verification.sparkConnectedAt,
    sparkImageAt: verification.sparkImageAt,
    samVerifiedAt: verification.samAt,
    samLastDetections: verification.samLastDetections,
    lastFailure: verification.lastFailure,
    lastWarning: verification.lastWarning,
    billableAccess: config.billableAccess,
    bindHost: config.bindHost,
  };
}

/**
 * Billable-endpoint protection (Phase 1C, hardened Phase 1D).
 * A frontend button is NOT authentication, so billable endpoints
 * (/api/meta/test, /api/analyze) are protected server-side by
 * ./billable.ts. Phase 1D correction: the Host header is
 * client-controlled and is never consulted — only the actual remote
 * socket address decides loopback, and the server binds to loopback
 * by default (see config.bindHost). A forged `Host: localhost` from a
 * remote IP therefore cannot bypass local-only access.
 * Returns null when allowed, otherwise an error for a 403/503/429.
 */
function billableGuard(req: IncomingMessage): { status: number; error: string } | null {
  const token = req.headers["x-frontier-approval-token"];
  const decision = decideBillableAccess(
    config,
    {
      remoteAddress: req.socket.remoteAddress ?? null,
      tokenHeader: typeof token === "string" ? token : null,
    },
    billableLimiter,
  );
  return decision.allowed ? null : { status: decision.status, error: decision.error };
}

/** Demo-grade approval authorization (Priority 5, honestly labeled). */
function approvalAuthorized(req: IncomingMessage): { ok: boolean; identity: string } {
  if (!config.approvalToken) {
    // No token configured: demo remains open, and /api/meta/status says so.
    // This is a documented limitation, not a security claim.
    return { ok: true, identity: "demo-user" };
  }
  const supplied = req.headers["x-frontier-approval-token"];
  if (typeof supplied === "string" && supplied.length > 0 && supplied === config.approvalToken) {
    return { ok: true, identity: "token-holder" };
  }
  return { ok: false, identity: "" };
}

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/api/health") {
      send(res, 200, { ok: true, service: "sentra-frontier", mode: metaStatus().mode, time: new Date().toISOString() });
      return;
    }
    if (req.method === "GET" && pathname === "/api/meta/status") {
      send(res, 200, metaStatus());
      return;
    }
    if (req.method === "POST" && pathname === "/api/meta/test") {
      // Genuine connectivity test: a real minimal Spark request when a key
      // is configured; a clear blocker report when it is not. The key is
      // never echoed, logged, or included in the result.
      const guard = billableGuard(req);
      if (guard) { send(res, guard.status, { error: guard.error }); return; }
      lastLiveTest = await testSparkConnectivity(config);
      if (lastLiveTest.ok) {
        verification.sparkConnectedAt = lastLiveTest.at;
        verification.lastFailure = null;
      } else if (config.metaApiKey) {
        // Only a real attempt (key configured) counts as a live failure.
        // A no-key blocker is reported in the test result, not stored as
        // a failure of the Meta API.
        verification.lastFailure = lastLiveTest.error;
      }
      await saveVerification(dataDir, verification);
      send(res, 200, { test: lastLiveTest, status: metaStatus() });
      return;
    }
    if (req.method === "POST" && pathname === "/api/calculate") {
      // Deterministic calculator: no Meta call, no billable guard, no
      // model output. Pure arithmetic on user-supplied inputs; invalid
      // inputs are rejected with 400, never silently corrected.
      const body = (await readJson(req)) as Record<string, unknown>;
      try {
        const result = calculateImprovement({
          currentMinutesPerUnit: body.currentMinutesPerUnit as number,
          proposedMinutesPerUnit: body.proposedMinutesPerUnit as number,
          unitsPerDay: body.unitsPerDay as number,
          laborCostPerHourUsd: body.laborCostPerHourUsd as number,
          workingDays: body.workingDays as number,
        });
        send(res, 200, { calculation: result });
      } catch (err) {
        send(res, 400, { error: err instanceof Error ? err.message : "Invalid calculator input." });
      }
      return;
    }
    if (req.method === "GET" && pathname === "/api/projects") {
      send(res, 200, { projects: store.list(), audit: [] });
      return;
    }
    const reportMatch = pathname.match(/^\/api\/projects\/([^/]+)\/report$/);
    if (req.method === "GET" && reportMatch) {
      const a = store.get(decodeURIComponent(reportMatch[1]));
      if (!a) { send(res, 404, { error: "Analysis not found." }); return; }
      send(res, 200, {
        report: {
          product: "Sentra Frontier",
          generatedAt: new Date().toISOString(),
          mode: a.mode,
          analysis: a,
          audit: store.auditFor(a.id),
          provenance: {
            imageStored: false,
            costNote: "Usage costs are estimates from published list prices, not billed charges. Fixture mode costs $0.",
            quantumTape: "Not connected in Phase 1B. Local three-role council only; QuantumTapeRequest contract preserved for a future authorized bridge.",
          },
          // Final Sprint: evidence links are PARTIAL. Recommendation →
          // observation links are validated and listed here; observation
          // → detection and plan-task links are UNLINKED by design
          // (never inferred from labels). See
          // docs/EVIDENCE-LINKING-PLAN.md.
          evidenceLinking: {
            implemented: "partial",
            links: a.evidenceLinks,
            droppedCitationIds: a.droppedCitationIds,
            unsupported: "Observation → detection links and plan-task links are currently UNLINKED. observation.detectionIds are empty by design; no link has been inferred from matching labels or model speculation. Recommendation → observation links above are validated council citations only.",
            plan: "docs/EVIDENCE-LINKING-PLAN.md",
          },
        },
      });
      return;
    }
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (req.method === "GET" && projectMatch) {
      const a = store.get(decodeURIComponent(projectMatch[1]));
      if (!a) { send(res, 404, { error: "Analysis not found." }); return; }
      send(res, 200, { analysis: a, audit: store.auditFor(a.id) });
      return;
    }
    const decideMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(approve|reject)$/);
    if (req.method === "POST" && decideMatch) {
      const auth = approvalAuthorized(req);
      if (!auth.ok) { send(res, 403, { error: "Approval requires a valid X-Frontier-Approval-Token header (FRONTIER_APPROVAL_TOKEN is set)." }); return; }
      const { analysis: a, duplicate } = await store.decide(
        decodeURIComponent(decideMatch[1]),
        decideMatch[2] === "approve",
        auth.identity,
      );
      if (!a) { send(res, 404, { error: "Analysis not found." }); return; }
      if (duplicate) {
        send(res, 409, { error: "This analysis was already decided; a second decision changes nothing and creates no duplicate tasks.", analysis: a, audit: store.auditFor(a.id) });
        return;
      }
      send(res, 200, { analysis: a, audit: store.auditFor(a.id) });
      return;
    }
    if (req.method === "POST" && pathname === "/api/analyze") {
      const guard = billableGuard(req);
      if (guard) { send(res, guard.status, { error: guard.error }); return; }
      const body = (await readJson(req)) as { mime?: unknown; imageBase64?: unknown };
      validateImageInput(body.mime, body.imageBase64);
      const analysis = await runAnalysis(
        config,
        { mime: body.mime as string, base64: body.imageBase64 as string },
      );
      // Genuine verification tracking (Priority 3): only a live analysis
      // counts, and only its successful parts count.
      if (analysis.mode === "live") {
        verification.sparkImageAt = analysis.createdAt;
        // Phase 1D: only successfully DECODED SAM results verify SAM —
        // never usage alone, never a protocol success alone, never a
        // malformed/truncated output. A valid completed zero-match
        // (decodedOk, 0 detections) does count.
        const decodedOk = analysis.samVerification?.phrasesDecodedOk ?? 0;
        if (decodedOk > 0) {
          verification.samAt = analysis.createdAt;
          verification.samLastDetections = analysis.samVerification?.detections ?? 0;
        }
        verification.lastWarning = analysis.samWarnings.length > 0 ? analysis.samWarnings.join(" ") : null;
        await saveVerification(dataDir, verification);
      }
      await store.add(analysis);
      send(res, 200, { analysis, audit: store.auditFor(analysis.id) });
      return;
    }
    send(res, 404, { error: "Route not found." });
  } catch (err) {
    if (err instanceof ValidationError) { send(res, 400, { error: err.message }); return; }
    if (err instanceof ProviderError) { send(res, err.statusCode, { error: err.message }); return; }
    console.error(err);
    send(res, 500, { error: "Internal server error." });
  }
});

if (process.env.NODE_ENV !== "test") {
  await store.init();
  verification = await loadVerification(dataDir);
  // Phase 1D: bind loopback by default (config.bindHost, 127.0.0.1).
  // Binding to 0.0.0.0 requires an explicit FRONTIER_BIND_HOST override,
  // and the billable guard still blocks non-loopback billable clients.
  server.listen(config.port, config.bindHost, () => {
    console.log(`Sentra Frontier server listening on http://${config.bindHost}:${config.port} (mode: ${metaStatus().mode}, billable: ${config.billableAccess})`);
  });
}
