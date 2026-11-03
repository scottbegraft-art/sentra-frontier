import type { RateLimiter } from "./rateLimit.js";

/**
 * Billable-endpoint access control (Phase 1D).
 *
 * Security correction: the Host header is client-controlled and must
 * NEVER establish whether a client is local. This module therefore
 * takes no Host value at all — only the actual remote socket address.
 * A forged `Host: localhost` from a remote IP cannot bypass local-only
 * access, because the Host is simply never consulted.
 *
 * Modes:
 *  - localhost-only (default): only loopback remote addresses pass.
 *  - token-required: the approval token header must match.
 *  - misconfigured: public allowed but no token — refuse everything
 *    billable rather than serving it unprotected.
 * A per-IP rate limit applies after authorization.
 */

export function isLoopbackAddress(remote: string | null | undefined): boolean {
  if (!remote) return false;
  // Node reports IPv4 loopback directly, IPv6 loopback as ::1, and
  // IPv4-mapped IPv6 as ::ffff:127.0.0.1. Nothing else counts — in
  // particular, no hostname, Host header, or X-Forwarded-For value.
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

export interface BillableRequest {
  remoteAddress: string | null | undefined;
  tokenHeader: string | null | undefined;
}

export interface BillableConfig {
  billableAccess: "localhost-only" | "token-required" | "misconfigured";
  approvalToken: string | null;
  billableRateLimitPerMinute: number;
}

export function decideBillableAccess(
  config: BillableConfig,
  req: BillableRequest,
  limiter: RateLimiter,
): { allowed: true } | { allowed: false; status: number; error: string } {
  if (config.billableAccess === "misconfigured") {
    return {
      allowed: false,
      status: 503,
      error: "Billable endpoints are misconfigured for public use: FRONTIER_ALLOW_PUBLIC_BILLABLE=true but no FRONTIER_APPROVAL_TOKEN is set. Refusing billable calls rather than serving them unprotected.",
    };
  }
  if (config.billableAccess === "localhost-only") {
    if (!isLoopbackAddress(req.remoteAddress)) {
      return {
        allowed: false,
        status: 403,
        error: "Billable endpoints are localhost-only in this configuration. Public deployment requires FRONTIER_ALLOW_PUBLIC_BILLABLE=true with FRONTIER_APPROVAL_TOKEN set.",
      };
    }
  } else if (req.tokenHeader !== config.approvalToken) {
    return {
      allowed: false,
      status: 403,
      error: "Billable endpoints require a valid X-Frontier-Approval-Token header in this configuration.",
    };
  }
  const ip = req.remoteAddress ?? "unknown";
  if (!limiter.allow(ip)) {
    return {
      allowed: false,
      status: 429,
      error: `Billable rate limit exceeded (${config.billableRateLimitPerMinute} requests/minute per IP). Wait and retry.`,
    };
  }
  return { allowed: true };
}
