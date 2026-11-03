# Sentra Frontier

**SEE IT. PROVE IT. IMPROVE IT.**

Actualized Intelligence that turns visual understanding into
explainable reasoning, measurable improvements, and human-approved
action.

Sentra Frontier is a hackathon entry for the Meta Global AI Developer
Hackathon (Startup Track, Push the Frontier). Upload a warehouse
packing workstation photo, and Frontier interprets the scene with
Meta's Muse Spark, segments the objects it names with SAM 3.1, puts
the reasoning through a three-role council that records its own
disagreements, quantifies the improvement with your own numbers, and
waits for your approval before any task is created. Every analysis
and decision is recorded in an auditable history with a downloadable
report.

## Honest status

* The full workflow is verified in **fixture mode**: structure,
overlays, council, evidence links, calculator, approval, audit,
and reports are real; scene content in fixture mode is placeholder
and is labeled FIXTURE everywhere.
* The Muse Spark and SAM 3.1 adapters are complete and
unit/parser-tested. **Live Meta verification is pending**
account access; no live result is claimed here. When a live run
succeeds, the UI mode badge changes to LIVE and the verification
timestamps are set by real requests — a configured key alone never
counts as verification.
* Nothing is executed before approval. The calculator's outputs are
projections from user inputs, not observed results, and labor-hour
value is not cash savings.

## What it does

1. **See it** — upload a workstation photo. Muse Spark 1.3
interprets the scene, separates observations from assumptions
(each with evidence and confidence), and proposes object
categories.
2. **Prove it** — SAM 3.1 segments those categories (boxes and
decoded masks overlaid on the photo, one Responses call per
category). A three-role council — Operations Analyst, Critical
Reviewer, Implementation Planner — examines the same evidence,
records disagreements and open questions, and makes
recommendations. Council recommendations link to the observations
that support them, and only to validated observations; links that
cannot be proven are shown as UNLINKED, never guessed.
3. **Improve it** — enter current vs. proposed time per unit, units
per day, labor rate, and working days. A deterministic calculator
shows time saved, productivity change, and labor-hour value, with
formulas and assumptions on screen.
4. **Approve it** — approve or reject the plan. Nothing happens
before approval, and every decision is audited.

## Run it

```bash
npm install          # server dependencies (TypeScript, Node built-ins)
npm run web:install  # frontend dependencies

# terminal 1: API on http://localhost:4000
npm run server:start
# terminal 2: UI on http://localhost:5173 (proxies /api to the server)
npm run web:dev
```

With a Meta Model API key (server side only, never in the client,
never in a public file):

```bash
cp .env.example .env   # then set MODEL\_API\_KEY in .env
npm run build          # build first: the server runs from server/dist/
npm run server:start
curl -X POST http://localhost:4000/api/meta/test   # genuine Spark probe
```

Without a key, the server runs in fixture mode — the full workflow,
with placeholder scene content.

## Demonstration

Record or run the demo in this order: problem → upload (mode badge
visible) → scene analysis → SAM overlays → council evidence →
calculator → approval → audit → report download. Full narration and
on-screen actions: `docs/competition/DEMO-NARRATION-FINAL.md`.
If you record in fixture mode, say so on camera; never present
fixture footage as live.

## Architecture

```
web/ (React + Vite + TypeScript UI)
  └─ proxies /api → server
server/src/
  ├─ providers/meta.ts   Muse Spark / Wonder Chat Completions adapters
  ├─ providers/sam.ts    SAM Responses streaming + @meta-sam/parser decoding
  ├─ council.ts          analyst / critic / planner council (local)
  ├─ analysis.ts         orchestration + Quantum Tape contract (not connected)
  ├─ evidence.ts         validated recommendation → observation links
  ├─ calculator.ts       deterministic improvement calculator
  ├─ store.ts            persisted history + append-only audit
  └─ server.ts           HTTP API, validation, billable-endpoint guard
```

Billable endpoints (`POST /api/meta/test`, `POST /api/analyze`) are
localhost-only by default: the API binds to `127.0.0.1`, the guard
validates only the real remote address (never the Host header), and
requests are rate-limited (30/minute per IP). Public use requires a
token and real authorization — the demo guard is not production auth.

## Tests

```bash
npm test    # server unit tests (node:test, compiled with tsc)
npm run build  # server build + web build
```

Release-candidate results (2 Nov 2026): **63 tests passing, 0
failing** (20 suites), production build passing, complete fixture
walkthrough verified. Evaluation dataset (15 cases):
`docs/EVALUATION.md`.

## Known limitations

* Live Meta verification pending account access (see above).
* Evidence linking is partial: recommendation → observation links
are validated; observation → detection and plan-task links are
UNLINKED by design.
* The council-vs-plan comparison is textual overlap only, not an
accuracy claim.
* Demo storage (`server/data/`) is single-user and is not a
production database. Images are never stored.
* Muse Wonder 1.0 is optional and off by default.

## Third-party notices

* `@meta-sam/parser` — Meta's official SAM output parser (MIT,
as published by Meta). Used for box and mask decoding.
* React, Vite, TypeScript — their respective open-source licenses
apply to those libraries, not to this project's code.
* This project uses Meta Model API models (Muse Spark, SAM) at
runtime when a key is configured; model usage is billed by Meta
under the key owner's team account.

## Originality

This repository's UI, server, council, evidence validation,
calculator, approval, and audit code were written for this hackathon
entry. Quantum Tape is represented only by a versioned request
contract (`QuantumTapeRequest`) for a future authorized bridge — no
Quantum Tape code is included and no Quantum Tape call is made. No
production application code, data, or credentials are included.

## License



Copyright © 2026 Sentra AI, Inc.



The source code contained in this repository is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only). See the LICENSE file for the full terms.



This license applies only to the materials included in this repository. All other Sentra AI, Inc. products, software, technologies, and intellectual property remain separately owned and are not licensed under this repository's license.

