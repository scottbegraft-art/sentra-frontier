import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Analysis, AuditEvent } from "./types.js";

/**
 * Project history store.
 *
 * Phase 1B persistence (Priority 5): analyses AND audit events now survive
 * restarts. Analyses are written to analyses.json and audit events appended
 * to audit.jsonl under server/data/ (gitignored, single-user demo storage —
 * explicitly NOT a production database; see README limitations). Uploaded
 * image bytes are NOT stored — only the analysis, decisions, and usage.
 * That keeps the audit useful without turning the server into a photo store.
 *
 * Decision semantics (Priority 5): decide() on an already-decided analysis
 * returns duplicate: true and changes NOTHING. The HTTP layer maps that to
 * 409. Rejected analyses never create tasks: their plan stays "rejected".
 */
export class Store {
  private analyses = new Map<string, Analysis>();
  private audit: AuditEvent[] = [];
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true }).catch(() => undefined);
    try {
      const raw = await readFile(path.join(this.dataDir, "analyses.json"), "utf8");
      const list = JSON.parse(raw) as Analysis[];
      for (const a of list) this.analyses.set(a.id, a);
    } catch {
      // No persisted analyses yet — start empty, honestly.
    }
    this.audit = await this.loadAuditFile();
  }

  private async persistAnalyses(): Promise<void> {
    const list = [...this.analyses.values()];
    await writeFile(path.join(this.dataDir, "analyses.json"), JSON.stringify(list, null, 2)).catch(() => undefined);
  }

  private async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(event);
    const line = JSON.stringify(event) + "\n";
    await appendFile(path.join(this.dataDir, "audit.jsonl"), line).catch(() => undefined);
  }

  async add(analysis: Analysis): Promise<void> {
    this.analyses.set(analysis.id, analysis);
    await this.persistAnalyses();
    await this.appendAudit({
      at: new Date().toISOString(),
      analysisId: analysis.id,
      event: "analysis_created",
      detail: `Analysis created in ${analysis.mode} mode with ${analysis.detections.length} detections and ${analysis.plan.length} proposed tasks.`,
    });
  }

  get(id: string): Analysis | undefined {
    return this.analyses.get(id);
  }

  list(): Analysis[] {
    return [...this.analyses.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async decide(
    id: string,
    approve: boolean,
    decidedBy: string | null = null,
  ): Promise<{ analysis: Analysis | undefined; duplicate: boolean }> {
    const a = this.analyses.get(id);
    if (!a) return { analysis: undefined, duplicate: false };
    if (a.approval !== "awaiting_approval") {
      return { analysis: a, duplicate: true };
    }
    a.approval = approve ? "approved" : "rejected";
    a.approvedAt = new Date().toISOString();
    a.decidedBy = decidedBy;
    a.plan = a.plan.map((t) => ({ ...t, status: approve ? "approved" : "rejected" }));
    await this.persistAnalyses();
    await this.appendAudit({
      at: a.approvedAt,
      analysisId: id,
      event: approve ? "tasks_approved" : "tasks_rejected",
      detail: approve
        ? `${a.plan.length} proposed tasks approved${decidedBy ? ` by ${decidedBy}` : ""}. Internal tasks only; no external action was taken by the server.`
        : `Proposed tasks rejected${decidedBy ? ` by ${decidedBy}` : ""}; no tasks were created.`,
    });
    return { analysis: a, duplicate: false };
  }

  auditFor(id: string): AuditEvent[] {
    return this.audit.filter((e) => e.analysisId === id);
  }

  async loadAuditFile(): Promise<AuditEvent[]> {
    try {
      const raw = await readFile(path.join(this.dataDir, "audit.jsonl"), "utf8");
      return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditEvent);
    } catch {
      return [];
    }
  }
}
