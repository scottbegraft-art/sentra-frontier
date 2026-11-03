/** Server-only configuration. Keys are read here and never sent to the client. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load a local `.env` file into process.env — Phase 1C, Priority 1.
 *
 * Why code, not only `node --env-file=.env`: Node's native flag exits
 * with an error when `.env` does not exist (verified: exit 9 on Node
 * 24.22.1), which would break fixture mode for anyone without a key.
 * This loader is the reliable equivalent: it silently does nothing when
 * no `.env` file exists, it never overrides an already-set environment
 * variable (so real deployment env always wins), it strips surrounding
 * quotes, ignores comments/blank lines, and it never logs a value —
 * only key names are ever returned, and those are never secret values.
 * Candidate locations, in order: the current working directory, then the
 * project root (two levels above this compiled file's directory).
 * The native alternative still works when `.env` exists:
 *   node --env-file=.env server/dist/server.js
 */
export function loadDotEnv(dirs?: string[]): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = dirs ?? [process.cwd(), path.resolve(here, "..", "..")];
  const loaded: string[] = [];
  for (const dir of candidates) {
    let text: string;
    try {
      text = readFileSync(path.join(dir, ".env"), "utf8");
    } catch {
      continue;
    }
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = value;
        loaded.push(key);
      }
    }
    if (loaded.length > 0) break;
  }
  return loaded;
}

export interface ServerConfig {
  port: number;
  metaApiKey: string | null;
  /** Which env var supplied the key (name only, for status reporting). */
  metaApiKeySource: string | null;
  metaBaseUrl: string;
  wonderEnabled: boolean;
  /** Request timeout for a single Meta model call. */
  modelTimeoutMs: number;
  /** When set, approve/reject require this value in X-Frontier-Approval-Token. */
  approvalToken: string | null;
  /** Directory for persisted analyses + audit log (server/data by default). */
  dataDir: string | null;
  /** Billable-endpoint access mode (see server.ts): localhost-only, token-required, or misconfigured. */
  billableAccess: "localhost-only" | "token-required" | "misconfigured";
  /** Per-IP billable requests allowed per minute (local demo default). */
  billableRateLimitPerMinute: number;
  /** Interface the API binds to. Default loopback only (Phase 1D). Override only with FRONTIER_BIND_HOST, deliberately. */
  bindHost: string;
}

function cleanEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // Official env var is MODEL_API_KEY; META_API_KEY is kept as a fallback
  // so Phase 1 setups keep working. The source name (not the value) is
  // reported by /api/meta/status.
  const modelKey = cleanEnv(env, "MODEL_API_KEY");
  const legacyKey = cleanEnv(env, "META_API_KEY");
  return {
    port: Number(env.PORT ?? 4000) || 4000,
    metaApiKey: modelKey ?? legacyKey,
    metaApiKeySource: modelKey ? "MODEL_API_KEY" : legacyKey ? "META_API_KEY" : null,
    metaBaseUrl: (cleanEnv(env, "META_API_BASE_URL") ?? "https://api.meta.ai/v1").replace(/\/$/, ""),
    wonderEnabled: env.META_WONDER_ENABLED === "true" || env.FRONTIER_ENABLE_WONDER === "true",
    modelTimeoutMs: 30_000,
    approvalToken: cleanEnv(env, "FRONTIER_APPROVAL_TOKEN"),
    dataDir: cleanEnv(env, "FRONTIER_DATA_DIR"),
    billableAccess: (() => {
      const allowPublic = cleanEnv(env, "FRONTIER_ALLOW_PUBLIC_BILLABLE") === "true";
      const token = cleanEnv(env, "FRONTIER_APPROVAL_TOKEN");
      if (!allowPublic) return "localhost-only";
      return token ? "token-required" : "misconfigured";
    })(),
    billableRateLimitPerMinute: Number(cleanEnv(env, "FRONTIER_BILLABLE_RATE_LIMIT_PER_MINUTE") ?? 30) || 30,
    bindHost: cleanEnv(env, "FRONTIER_BIND_HOST") ?? "127.0.0.1",
  };
}

export const SAM_MODEL = "sam-3.1";

/** Published Meta list prices used ONLY for live-usage cost estimates (Oct 2026 research). */
export const PRICES = {
  spark: { inputPerMillion: 1.25, outputPerMillion: 4.25 },
  wonder: { inputPerMillion: 4.0, outputPerMillion: 20.0 },
  samPerImage: 2.5 / 1000,
} as const;

export function estimateCost(
  model: "muse-spark-1.3" | "muse-wonder-1.0",
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  if (promptTokens === null || completionTokens === null) return null;
  const p = model === "muse-wonder-1.0" ? PRICES.wonder : PRICES.spark;
  return (promptTokens * p.inputPerMillion + completionTokens * p.outputPerMillion) / 1_000_000;
}
