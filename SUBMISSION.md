# Submission Deliverables Guide

Use this checklist to prepare and package your take-home submission. This file is a **workflow guide only** — it does not contain assignment text.

---

## Pre-submission completeness check

| Requirement | Status | Notes / Action |
|---|---|---|
| Real agent loop (plan → act → re-plan) | ✅ Done | `src/agent.js` — see `trace.json` |
| PDF ingestion | ✅ Done | `src/pdf.js` — text layer + OCR |
| Structured discharge draft (all sections) | ✅ Done | `discharge_summary_draft.json` schema |
| No fabrication guardrail | ✅ Done | `missing` status, no guessing |
| Pending/missing handling | ✅ Done | Explicit `missing` + reasons |
| Medication reconciliation | ✅ Done | `src/tools.js` |
| Conflict handling | ⚠️ Partial | Diagnoses, dates, evidence conflicts; expand if time |
| Tool use (interaction + escalation) | ✅ Done | Mock tools in `src/tools.js` |
| Failure handling + retries | ✅ Done | `withRetries`, review flags |
| Step cap control | ✅ Done | `--maxSteps` (default 35) |
| Observability / trace | ✅ Done | `trace.json` per patient |
| RAG evidence grounding | ✅ Done | `src/retrieval.js`, `src/ragExtract.js` |
| Part 2 learning loop | ✅ Demo | `src/learning.js` — stretch, not production ML |
| **All patient PDFs processed** | ❌ You | Currently 1 PDF in `input/patient_sources/` |
| **Drafts + traces for every patient** | ❌ You | Generate under `runs/submission/` |
| **Video demo recorded** | ❌ You | 3–5 min Loom/screen recording |
| **GitHub repo or zip ready** | ⚠️ You | Code committed; push + tag release |

Legend: ✅ implemented · ⚠️ partial / needs your action · ❌ not done yet

---

## Step 1 — Prepare patient inputs

Place **every provided patient PDF** in the workspace:

```text
input/patient_sources/
  patient_001.pdf
  patient_002.pdf
  ...
```

Keep data local (synthetic only). Do not commit real patient data.

---

## Step 2 — Generate all required outputs

From project root:

```powershell
npm install

# Batch run all PDFs in input folder
npm start -- --input "./input/patient_sources" --output ./runs/submission --maxSteps 35

# Part 2 metrics (optional stretch)
npm run learn -- --drafts ./runs/submission --out ./runs/submission/learning_report.json
```

Verify outputs exist for **each patient**:

```text
runs/submission/
  <patient_id>/
    discharge_summary_draft.json
    trace.json
  run_summary.json
  learning_report.json          # if Part 2 run
```

> `runs/` is gitignored. For submission, either attach a **separate zip of `runs/submission/`** or copy outputs into your submission package.

---

## Step 3 — Record the video demo (3–5 minutes)

Suggested script:

1. **Intro (30s)** — project purpose, safety-first drafting
2. **Run patient A (60–90s)** — live terminal run; show draft JSON highlights
3. **Run patient B (60–90s)** — pick one with missing/pending/conflict/OCR flags
4. **Trace walkthrough (60s)** — open `trace.json`; point to:
   - `build_rag_index`
   - an extract step with `evidence`
   - a **flag/escalation** moment (conflict, OCR, med reconciliation, or `missing` instead of guess)
5. **Part 2 (30s, if attempted)** — show `learning_report.json` before/after
6. **Close (15s)** — limitations + clinician review reminder

Upload to Loom/YouTube (unlisted) and save the link for submission.

---

## Step 4 — Package source code

### Option A — GitHub

```powershell
git add .
git commit -m "Prepare submission: RAG agent, OCR ingest, Part 2 demo"
git push origin master
```

Include repo URL in submission form.

### Option B — Zip

Exclude heavy folders:

- `node_modules/`
- `.git/` (optional)

Include:

- all `src/` files
- `package.json`, `package-lock.json`
- `README.md`, `ARCHITECTURE.md`, `SUBMISSION.md`
- optionally `runs/submission/` as separate zip

---

## Step 5 — Final submission bundle

Submit these five items:

| # | Deliverable | Where to get it |
|---|---|---|
| 1 | Source code + run instructions | GitHub link or zip |
| 2 | Drafts + traces for all patients | `runs/submission/<patient_id>/` |
| 3 | Part 2 artifacts (if attempted) | `learning_report.json` + `src/learning.js` |
| 4 | Video demo link | Your Loom/YouTube URL |
| 5 | README (design + guardrails + limits) | `README.md` |

---

## What to highlight in review (evaluator talking points)

- **Clinical safety first** — show a field marked `missing` rather than invented
- **Agentic behavior** — trace shows planning changes after observations
- **Messy data handling** — OCR flag, conflict flag, or pending results
- **Evidence grounding** — `evidence` array on known fields
- **Honest limitations** — OCR noise, multi-patient PDF mixing, mock tools

---

## Quick smoke test before you submit

```powershell
node -e "const {buildIndex,retrieveForField}=require('./src/retrieval'); console.log('retrieval ok')"
npm start -- --input "./input/patient_sources" --output ./runs/smoke --maxSteps 35
```

Confirm:

- [ ] No crash on your patient set
- [ ] At least one draft has `evidence` populated
- [ ] Trace includes `load_documents`, `build_rag_index`, `finalize` (or step-cap flag if OCR-heavy)
- [ ] `review_flags` present where expected (OCR, conflicts, missing)

---

## If you run out of time

State clearly in README:

- What is complete (Part 1 core + RAG + OCR)
- What is partial (field extraction quality on scanned PDFs, all-patient batch)
- What you would do next (patient filter, embeddings, better extractors)

Partial but honest submissions are acceptable.
