import { useEffect, useState } from "react";
import type { Analysis, AuditEvent, CalculatorResult, LiveTestResult, MetaStatus } from "./types";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.includes(",") ? s.split(",")[1] : s);
    };
    r.onerror = () => reject(new Error("Could not read the image file."));
    r.readAsDataURL(file);
  });
}

/** Draws a simple synthetic workstation (bench, tool, bin) and returns PNG base64. */
function makeSamplePng(): Promise<{ base64: string; dataUrl: string }> {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 560;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#dbeafe";
    ctx.fillRect(0, 0, 900, 560);
    ctx.fillStyle = "#94a3b8";
    ctx.fillRect(0, 420, 900, 20); // floor line
    ctx.fillStyle = "#92400e";
    ctx.fillRect(70, 200, 760, 30); // bench top
    ctx.fillStyle = "#78350f";
    ctx.fillRect(110, 230, 24, 190);
    ctx.fillRect(760, 230, 24, 190);
    ctx.fillStyle = "#dc2626";
    ctx.fillRect(180, 235, 160, 90); // tool block, left
    ctx.fillStyle = "#111827";
    ctx.fillRect(200, 250, 120, 18);
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(610, 170, 180, 150); // storage bin, right
    ctx.fillStyle = "#dbeafe";
    ctx.fillRect(630, 190, 140, 18);
    ctx.fillStyle = "#111827";
    ctx.font = "28px sans-serif";
    ctx.fillText("Sample workstation drawing", 200, 60);
    ctx.font = "20px sans-serif";
    ctx.fillText("Not a photograph — use it to test the workflow.", 180, 500);
    const dataUrl = canvas.toDataURL("image/png");
    resolve({ base64: dataUrl.split(",")[1], dataUrl });
  });
}

export default function App() {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [file, setFile] = useState<{ mime: string; base64: string; dataUrl: string; name: string } | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [history, setHistory] = useState<Analysis[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveTest, setLiveTest] = useState<LiveTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [selectedRec, setSelectedRec] = useState<string | null>(null);
  const [calcInputs, setCalcInputs] = useState({ currentMinutesPerUnit: 10, proposedMinutesPerUnit: 8, unitsPerDay: 100, laborCostPerHourUsd: 20, workingDays: 20 });
  const [calcResult, setCalcResult] = useState<CalculatorResult | null>(null);
  const [calcError, setCalcError] = useState<string | null>(null);

  const runCalculator = async () => {
    setCalcError(null);
    try {
      const r = await fetch("/api/calculate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(calcInputs) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `Calculation failed (${r.status}).`);
      setCalcResult(body.calculation);
    } catch (e) {
      setCalcError(e instanceof Error ? e.message : "Calculation failed.");
    }
  };

  const refreshStatus = async () => {
    try {
      const r = await fetch("/api/meta/status");
      if (r.ok) setStatus(await r.json());
    } catch { /* status banner stays hidden until the server is up */ }
  };
  const refreshHistory = async () => {
    try {
      const r = await fetch("/api/projects");
      if (r.ok) setHistory((await r.json()).projects ?? []);
    } catch { /* ignore */ }
  };
  useEffect(() => {
    void refreshStatus();
    void refreshHistory();
  }, []);

  const onFile = async (f: File) => {
    setError(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) {
      setError("Please choose a JPEG, PNG, or WebP image.");
      return;
    }
    if (f.size > 8 * 1024 * 1024) {
      setError("Image is larger than the 8 MB limit.");
      return;
    }
    const base64 = await fileToBase64(f);
    setFile({ mime: f.type, base64, dataUrl: `data:${f.type};base64,${base64}`, name: f.name });
    setAnalysis(null);
  };

  const onSample = async () => {
    const s = await makeSamplePng();
    setFile({ mime: "image/png", base64: s.base64, dataUrl: s.dataUrl, name: "sample-workstation.png" });
    setAnalysis(null);
    setError(null);
  };

  const analyze = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mime: file.mime, imageBase64: file.base64 }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `Analysis failed (${r.status}).`);
      setAnalysis(body.analysis);
      setAudit(body.audit ?? []);
      await refreshHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed.");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approve: boolean) => {
    if (!analysis) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${analysis.id}/${approve ? "approve" : "reject"}`, { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Decision failed.");
      setAnalysis(body.analysis);
      setAudit(body.audit ?? []);
      await refreshHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed.");
    } finally {
      setBusy(false);
    }
  };

  const runLiveTest = async () => {
    setTesting(true);
    setError(null);
    try {
      const r = await fetch("/api/meta/test", { method: "POST" });
      const body = await r.json();
      setLiveTest(body.test ?? null);
      if (body.status) setStatus(body.status);
      if (!body.test?.ok) setError(body.test?.error ?? "Connectivity test failed.");
    } catch {
      setError("Connectivity test request failed.");
    } finally {
      setTesting(false);
    }
  };

  const downloadReport = async () => {
    if (!analysis) return;
    const r = await fetch(`/api/projects/${analysis.id}/report`);
    if (!r.ok) { setError("Report download failed."); return; }
    const blob = new Blob([JSON.stringify(await r.json(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sentra-frontier-report-${analysis.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const loadHistory = async (id: string) => {
    const r = await fetch(`/api/projects/${id}`);
    if (r.ok) {
      const body = await r.json();
      setAnalysis(body.analysis);
      setAudit(body.audit ?? []);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>Sentra Frontier</h1>
        <p><strong>Turn a workstation photo and a few numbers into a traceable, challenged, approved improvement plan.</strong></p>
        <p className="muted">1. Upload a photo → 2. Muse Spark interprets it, SAM 3.1 segments objects → 3. A three-role council challenges the reasoning → 4. You quantify the improvement with your own numbers → 5. You approve before any task is created. Meta Global AI Developer Hackathon, Startup Track, Push the Frontier. Models: Muse Spark 1.3 (scene + reasoning) · SAM 3.1 (segmentation) · Muse Wonder off by default.</p>
      </header>

      {status && (
        <div className={`banner ${status.mode === "live" ? "live" : ""}`}>
          <strong>Mode: {status.mode === "live" ? "LIVE (Meta Model API)" : "FIXTURE MODE"}</strong>
          {status.mode === "fixture" ? (
            <span> — no Meta API key is configured on the server, so no Meta call is made. Structure, overlays, plan and approval are real; scene content is placeholder.</span>
          ) : (
            <span> — Muse Spark {status.spark.model} is configured. SAM 3.1 live segmentation is still unverified (see below).</span>
          )}
          <div className="muted" style={{ marginTop: 6 }}>
            SAM 3.1: {status.sam.note} &nbsp;|&nbsp; Muse Wonder: {status.wonder.enabled ? "enabled" : "off"} — {status.wonder.note}
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            Approval protection: {status.approvalAuth === "token" ? "token required" : "OPEN — no approval token configured (demo default, see README limitations)"} &nbsp;|&nbsp;
            Key source: {status.keySource ?? "none"} &nbsp;|&nbsp;
            Billable endpoints: {status.billableAccess === "localhost-only" ? "localhost-only" : status.billableAccess === "token-required" ? "token required" : "MISCONFIGURED — billable calls refused"} &nbsp;|&nbsp;
            API bound to: {status.bindHost}
            {status.sparkConnectedAt && <> &nbsp;|&nbsp; Spark verified: {new Date(status.sparkConnectedAt).toLocaleString()}</>}
            {status.samVerifiedAt && <> &nbsp;|&nbsp; SAM verified: {new Date(status.samVerifiedAt).toLocaleString()} ({status.samLastDetections ?? 0} detections)</>}
            {status.lastFailure && <> &nbsp;|&nbsp; Last failure: {status.lastFailure}</>}
            {status.lastWarning && <> &nbsp;|&nbsp; Last warning: {status.lastWarning}</>}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="secondary" onClick={() => void runLiveTest()} disabled={testing}>
              {testing ? "Testing…" : "Run genuine Meta connectivity test"}
            </button>
          </div>
          {liveTest && (
            <div style={{ marginTop: 8 }}>
              <strong>Last live test ({new Date(liveTest.at).toLocaleString()}): </strong>
              {liveTest.ok ? (
                <span>OK — {liveTest.model}, HTTP {liveTest.httpStatus}, {liveTest.latencyMs}ms, response "{liveTest.responseText}", tokens {liveTest.promptTokens ?? "?"} in / {liveTest.completionTokens ?? "?"} out, estimated ${liveTest.estimatedCostUsd ?? "?"} (estimate, not a billed charge).</span>
              ) : (
                <span>FAILED — {liveTest.error}</span>
              )}
            </div>
          )}
        </div>
      )}

      <section className="card">
        <h2>1. Upload a workstation photo</h2>
        <div className="row">
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
          <button className="secondary" onClick={() => void onSample()}>Use sample workstation drawing</button>
          <button onClick={() => void analyze()} disabled={!file || busy}>{busy ? "Analyzing…" : "Analyze photo"}</button>
        </div>
        {file && <p className="muted">Selected: {file.name} ({file.mime})</p>}
        {file && (
          <div className="preview">
            <img src={file.dataUrl} alt="Uploaded workstation" />
            {analysis?.detections.map((d) => (
              <div key={d.id} className="box" style={{ left: `${d.box.x * 100}%`, top: `${d.box.y * 100}%`, width: `${d.box.width * 100}%`, height: `${d.box.height * 100}%` }}>
                <span>{d.label} · {d.confidence === null ? "no confidence reported" : `${Math.round(d.confidence * 100)}%`}{d.maskAvailable ? " · mask" : ""}</span>
                {d.maskSvgPath && d.maskRasterWidth && d.maskRasterHeight && (
                  <svg viewBox={`-1 -1 ${d.maskRasterWidth + 2} ${d.maskRasterHeight + 2}`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
                    <path d={d.maskSvgPath} fill="rgba(250, 204, 21, 0.45)" stroke="#facc15" strokeWidth={0.5} />
                  </svg>
                )}
              </div>
            ))}
          </div>
        )}
        {analysis && analysis.detections.length === 0 && (
          <p className="muted">No segmentation overlays for this run — SAM 3.1 live segmentation is pending protocol verification. The scene interpretation below is still shown in full.</p>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {analysis && (
        <>
          <section className="card">
            <h2>2. Scene interpretation</h2>
            <p>
              <span className={`pill ${analysis.mode}`}>{analysis.mode.toUpperCase()}</span>
              Overall confidence: <strong>{Math.round(analysis.overallConfidence * 100)}%</strong> (mean of observation confidences — not a benchmark)
            </p>
            <p>{analysis.sceneSummary}</p>
            <p><strong>Categories sent to SAM:</strong> {analysis.categories.join(", ")}</p>
            <p className="muted">{analysis.honestyNote}</p>
            {analysis.samWarnings.length > 0 && (
              <ul>
                {analysis.samWarnings.map((w, i) => (<li key={i} className="muted">SAM note: {w}</li>))}
              </ul>
            )}
            <p className="muted">
              Usage (estimates from published list prices, NOT billed charges): {analysis.usage.map((u) => `${u.provider}/${u.model}: ${u.promptTokens ?? "?"} in, ${u.completionTokens ?? "?"} out, $${u.costUsd ?? "?"} estimated, ${u.latencyMs}ms`).join(" · ")}
            </p>
          </section>

          <section className="card">
            <h2>3. Observations — what was seen vs. what was assumed</h2>
            <ul>
              {analysis.observations.map((o) => (
                <li key={o.id}>
                  <span className={`pill ${o.kind}`}>{o.kind}</span> {o.text}
                  <div className="muted">Evidence: {o.evidence} · Confidence {Math.round(o.confidence * 100)}%</div>
                </li>
              ))}
            </ul>
            <h3>Possible operational issues</h3>
            <ul>
              {analysis.issues.map((i) => (
                <li key={i.id}>
                  <span className={`pill ${i.severity}`}>{i.severity}</span> <strong>{i.title}</strong> — {i.description}
                </li>
              ))}
            </ul>
          </section>

          {analysis.council && (
            <section className="card">
              <h2>3b. Reasoning council — analyst / critic / planner</h2>
              <p className="muted">Council mode: {analysis.council.mode}. Roles cite observation ids; a failed role contributes no points, never fabricated text. Quantum Tape is not connected — this is the local council.</p>
              {[analysis.council.analyst, analysis.council.critic, analysis.council.planner].map((role) => (
                <div key={role.role}>
                  <h3>{role.role === "analyst" ? "Operations Analyst" : role.role === "critic" ? "Critical Reviewer" : "Implementation Planner"}</h3>
                  <p>{role.position}</p>
                  {role.error && <p className="error">Role call failed: {role.error}</p>}
                  <ul>
                    {role.points.map((p, i) => (<li key={i}>{p}{role.evidenceObservationIds.length > 0 ? <span className="muted"> (evidence: {role.evidenceObservationIds.join(", ")})</span> : null}</li>))}
                  </ul>
                </div>
              ))}
              <h3>Disagreements</h3>
              <ul>{analysis.council.disagreements.map((d, i) => (<li key={i}>{d}</li>))}</ul>
              <h3>Open questions (need a human / on-site check)</h3>
              <ul>{analysis.council.openQuestions.map((q, i) => (<li key={i}>{q}</li>))}</ul>
              <h3>Council recommendations</h3>
              <ul>{analysis.council.recommendations.map((r) => (<li key={r.id}>{r.text}{r.observationIds.length > 0 ? <span className="muted"> (validated evidence: {r.observationIds.join(", ")})</span> : <span className="muted"> (no validated observation cited — UNVERIFIED)</span>}</li>))}</ul>
              {analysis.councilComparison && (
                <div>
                  <h3>Single-model plan vs. council recommendations (textual comparison only)</h3>
                  <p className="muted">{analysis.councilComparison.note}</p>
                  <p>Shared: {analysis.councilComparison.shared.length > 0 ? analysis.councilComparison.shared.join(" · ") : "none"}</p>
                  <p>Council-only: {analysis.councilComparison.councilOnly.length > 0 ? analysis.councilComparison.councilOnly.join(" · ") : "none"}</p>
                  <p>Plan-only: {analysis.councilComparison.planOnly.length > 0 ? analysis.councilComparison.planOnly.join(" · ") : "none"}</p>
                </div>
              )}
            </section>
          )}

          <section className="card">
            <h2>3c. Evidence inspection — click a recommendation</h2>
            <p className="muted">Links below are validated council citations only. Observation → detection associations are currently <strong>UNLINKED</strong>: observations come from Spark text, not from SAM detections, so no detection link is claimed — not even when a label matches. Plan tasks are also unlinked in this phase.</p>
            <div className="row">
              {analysis.council?.recommendations.map((r) => (
                <button key={r.id} className="secondary" onClick={() => setSelectedRec(r.id)}>{r.id}: {r.text.slice(0, 60)}{r.text.length > 60 ? "…" : ""}</button>
              ))}
            </div>
            {selectedRec && analysis.council && (() => {
              const rec = analysis.council.recommendations.find((r) => r.id === selectedRec);
              if (!rec) return null;
              const linkedObs = analysis.observations.filter((o) => rec.observationIds.includes(o.id));
              const linkedDets = linkedObs.flatMap((o) => analysis.detections.filter((d) => o.detectionIds.includes(d.id)));
              return (
                <div style={{ marginTop: 12 }}>
                  <h3>Recommendation {rec.id}</h3>
                  <p>{rec.text}</p>
                  <h4>Supporting observations ({linkedObs.length})</h4>
                  {linkedObs.length === 0 ? <p className="muted">UNVERIFIED — this recommendation cites no validated observation.</p> : (
                    <ul>{linkedObs.map((o) => (<li key={o.id}><span className={`pill ${o.kind}`}>{o.kind}</span> {o.text}<div className="muted">Evidence: {o.evidence} · Confidence {Math.round(o.confidence * 100)}%</div></li>))}</ul>
                  )}
                  <h4>Detected objects / image regions for those observations</h4>
                  {linkedDets.length === 0 ? <p className="muted">UNLINKED — no validated detection is associated with these observations. See the overlay in Section 1 for all detections, but do not read a label match as a link.</p> : (
                    <ul>{linkedDets.map((d) => (<li key={d.id}>{d.label} — box {Math.round(d.box.x * 100)}%, {Math.round(d.box.y * 100)}%, {Math.round(d.box.width * 100)}% × {Math.round(d.box.height * 100)}%{d.maskAvailable ? " · mask available" : ""}</li>))}</ul>
                  )}
                  <h4>Council analysis and objections</h4>
                  <p>Analyst: {analysis.council.analyst.position} · Critic: {analysis.council.critic.position} · Planner: {analysis.council.planner.position}</p>
                  <ul>{analysis.council.disagreements.map((d, i) => (<li key={i}>Disagreement: {d}</li>))}</ul>
                  <h4>Assumptions and evidence gaps</h4>
                  <ul>
                    {analysis.observations.filter((o) => o.kind === "assumption").map((o) => (<li key={o.id}>{o.text}</li>))}
                    {analysis.council.openQuestions.map((q, i) => (<li key={`q${i}`}>Open question: {q}</li>))}
                  </ul>
                  <h4>Action proposed and approval status</h4>
                  <p>Plan approval status: <strong>{analysis.approval}</strong>. Plan tasks are listed in Section 4 and are created only after approval.</p>
                  {analysis.droppedCitationIds.length > 0 && <p className="muted">Dropped council citations (ids that did not exist, never linked): {analysis.droppedCitationIds.join(", ")}</p>}
                </div>
              );
            })()}
          </section>

          <section className="card">
            <h2>4. Improvement plan — approval required</h2>
            <p>
              Status: <strong>{analysis.approval === "awaiting_approval" ? "Awaiting your approval — no tasks have been executed" : analysis.approval}</strong>
            </p>
            <ul>
              {analysis.plan.map((t) => (
                <li key={t.id}><strong>{t.title}</strong> ({t.status}) — {t.detail}</li>
              ))}
            </ul>
            <p className="muted">Evidence links: council recommendations above are linked to validated observations (Section 3c). Plan tasks themselves are currently UNLINKED — no link has been inferred from matching labels. See docs/EVIDENCE-LINKING-PLAN.md.</p>
            {analysis.approval === "awaiting_approval" && (
              <div className="row">
                <button onClick={() => void decide(true)} disabled={busy}>Approve tasks</button>
                <button className="danger" onClick={() => void decide(false)} disabled={busy}>Reject tasks</button>
              </div>
            )}
            {analysis.approval !== "awaiting_approval" && (
              <p className="muted">Decision recorded in the audit log below{analysis.decidedBy ? ` (decided by ${analysis.decidedBy})` : ""}. This demo creates no external tasks, messages, or purchases — approval only changes the plan status here. A second decision is rejected (409) and creates no duplicate tasks.</p>
            )}
            <div className="row">
              <button className="secondary" onClick={() => void downloadReport()}>Download report (JSON)</button>
            </div>
          </section>

          <section className="card">
            <h2>5. Auditable project history</h2>
            <ul>
              {audit.map((e, i) => (
                <li key={i}><span className="muted">{new Date(e.at).toLocaleString()}</span> — <strong>{e.event}</strong>: {e.detail}</li>
              ))}
            </ul>
          </section>
        </>
      )}

      <section className="card">
        <h2>Measurable improvement calculator — your numbers, deterministic math</h2>
        <p className="muted">This calculator uses only the numbers you enter. It is a projection, not an observed result, and labor-hour value is not cash savings. No Meta call is made here.</p>
        <div className="row">
          <label>Current minutes / unit <input type="number" value={calcInputs.currentMinutesPerUnit} onChange={(e) => setCalcInputs({ ...calcInputs, currentMinutesPerUnit: Number(e.target.value) })} /></label>
          <label>Proposed minutes / unit <input type="number" value={calcInputs.proposedMinutesPerUnit} onChange={(e) => setCalcInputs({ ...calcInputs, proposedMinutesPerUnit: Number(e.target.value) })} /></label>
          <label>Units / day <input type="number" value={calcInputs.unitsPerDay} onChange={(e) => setCalcInputs({ ...calcInputs, unitsPerDay: Number(e.target.value) })} /></label>
          <label>Labor $ / hour <input type="number" value={calcInputs.laborCostPerHourUsd} onChange={(e) => setCalcInputs({ ...calcInputs, laborCostPerHourUsd: Number(e.target.value) })} /></label>
          <label>Working days <input type="number" value={calcInputs.workingDays} onChange={(e) => setCalcInputs({ ...calcInputs, workingDays: Number(e.target.value) })} /></label>
          <button onClick={() => void runCalculator()}>Calculate</button>
        </div>
        {calcError && <p className="error">{calcError}</p>}
        {calcResult && (
          <div>
            <p>Time saved: <strong>{calcResult.timeSavedPerUnitMinutes.toFixed(2)} min/unit</strong> · {calcResult.timeSavedPerDayHours.toFixed(2)} hours/day · {calcResult.timeSavedPerPeriodHours.toFixed(2)} hours over {calcResult.inputs.workingDays} days</p>
            <p>Productivity: {calcResult.unitsPerHourBefore.toFixed(2)} → {calcResult.unitsPerHourAfter.toFixed(2)} units/hour ({calcResult.productivityChangePercent.toFixed(1)}%)</p>
            <p>Labor-hour value: <strong>${calcResult.laborHourValueUsd.toFixed(2)}</strong> — value of hours at the stated rate, NOT cash savings.</p>
            <p className="muted">Formulas: {calcResult.formulas.join(" · ")}</p>
            <ul>{calcResult.assumptions.map((a, i) => (<li key={i} className="muted">{a}</li>))}</ul>
            <p className="muted">{calcResult.disclaimer}</p>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Project history</h2>
        {history.length === 0 ? (
          <p className="muted">No analyses yet in this server session. Upload and analyze a photo to start the history.</p>
        ) : (
          history.map((h) => (
            <div key={h.id} className="history-item">
              <div>{new Date(h.createdAt).toLocaleString()} — <span className={`pill ${h.mode}`}>{h.mode}</span> {h.sceneSummary.slice(0, 110)}</div>
              <div className="muted">Approval: {h.approval} · {h.plan.length} tasks · {h.detections.length} detections</div>
              <button className="secondary" onClick={() => void loadHistory(h.id)}>Open</button>
            </div>
          ))
        )}
      </section>

      <footer className="muted">
        <p>Quantum Tape connection is Phase 2: Frontier exposes a versioned <code>QuantumTapeRequest</code> contract (mode, observations, detections, risk, approvalRequired) for a secure server-side endpoint. No Quantum Tape call is made in Phase 1, and no production Base44 service is touched.</p>
      </footer>
    </div>
  );
}
