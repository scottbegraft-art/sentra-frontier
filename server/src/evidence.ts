import type { Analysis, Council, EvidenceLink, Observation } from "./types.js";

/**
 * Evidence-link construction (Final Sprint, per docs/EVIDENCE-LINKING-PLAN.md).
 *
 * Validated links only:
 *  - Council recommendation → observation: the planner role cites
 *    observation ids; each id is intersected with the analysis's real
 *    observation ids. Valid ids become links (basis "council-citation",
 *    with the observation's own text recorded as citedText so relevance
 *    is checkable). Unknown ids are DROPPED and reported, never linked.
 *  - Observation → detection: NO links are produced. Observations come
 *    from Spark interpretation text, not from SAM detections, so no
 *    pipeline provenance exists for such a link. In particular, a
 *    detection and an observation sharing a label/category is NOT a
 *    link (label matching alone is forbidden). The UI and report must
 *    show this association as UNLINKED.
 *  - Plan tasks: no link fields exist; plan tasks are UNLINKED by design
 *    in this phase. Council recommendations are the inspectable unit.
 */

export function validateCitationIds(
  cited: string[],
  validIds: Set<string>,
): { valid: string[]; dropped: string[] } {
  const valid: string[] = [];
  const dropped: string[] = [];
  for (const id of cited) {
    if (validIds.has(id)) valid.push(id);
    else dropped.push(id);
  }
  return { valid, dropped };
}

export function buildEvidenceLinks(
  council: Council,
  observations: Observation[],
): { links: EvidenceLink[]; droppedCitationIds: string[]; filteredCouncil: Council } {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const validIds = new Set(byId.keys());
  const links: EvidenceLink[] = [];
  const dropped: string[] = [];
  const filteredRecommendations = council.recommendations.map((rec) => {
    const { valid, dropped: d } = validateCitationIds(rec.observationIds, validIds);
    dropped.push(...d);
    for (const obsId of valid) {
      const obs = byId.get(obsId)!;
      links.push({
        id: `link-${links.length + 1}`,
        fromType: "recommendation",
        fromId: rec.id,
        toType: "observation",
        toId: obsId,
        basis: "council-citation",
        citedText: obs.text,
        createdAt: new Date().toISOString(),
        createdBy: "council",
      });
    }
    return { ...rec, observationIds: valid };
  });
  return {
    links,
    droppedCitationIds: [...new Set(dropped)],
    filteredCouncil: { ...council, recommendations: filteredRecommendations },
  };
}

/** Deterministic textual comparison: shared / council-only / plan-only, by normalized text. */
export function compareCouncilToPlan(
  planTitles: string[],
  recommendationTexts: string[],
): NonNullable<Analysis["councilComparison"]> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const similar = (a: string, b: string) => {
    const na = norm(a);
    const nb = norm(b);
    return na.length > 0 && nb.length > 0 && (na === nb || na.includes(nb) || nb.includes(na));
  };
  const shared: string[] = [];
  const councilOnly: string[] = [];
  const planOnly: string[] = [];
  for (const r of recommendationTexts) {
    if (planTitles.some((t) => similar(r, t))) shared.push(r);
    else councilOnly.push(r);
  }
  for (const t of planTitles) {
    if (!recommendationTexts.some((r) => similar(r, t))) planOnly.push(t);
  }
  return {
    singleModelPlanTitles: planTitles,
    councilRecommendationTexts: recommendationTexts,
    shared,
    councilOnly,
    planOnly,
    note: "Textual comparison only: which recommendation texts overlap the single-model plan titles. This is NOT an accuracy ranking and does not claim the council is more accurate.",
  };
}
