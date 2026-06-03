# Discharge Summary Agent

Agentic AI system that ingests synthetic patient source-note PDFs and produces **structured discharge-summary drafts for clinician review**. Built for a take-home assignment with a strict **no-fabrication** policy.

**Docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [SUBMISSION.md](./SUBMISSION.md)

---

## Quick start

```powershell
npm install
npm start -- --input "./input/patient_sources" --output ./runs/latest --maxSteps 35
npm run learn -- --drafts ./runs/latest --out ./runs/latest/learning_report.json
```

**Input modes:** single PDF · folder of PDFs · folder of patient subfolders  
**Outputs:** `discharge_summary_draft.json`, `trace.json`, `run_summary.json` per run

---

## Agent loop design

The core loop in `src/agent.js` is **from-scratch** (no LangGraph/CrewAI):

1. **Plan** — inspect state: missing fields, RAG index readiness, conflicts, safety checks
2. **Act** — execute one action (ingest, index, extract, tool call, finalize)
3. **Observe** — log reasoning → action → input → result/error → next in `trace.json`
4. **Re-plan** — repeat until `finalize` or hard step cap (`maxSteps`, default 35)

Typical action flow:

```
load_documents → build_rag_index → extract_* (per field) → detect_conflicts
→ check_interactions → escalate_conflicts → finalize
```

Each field is attempted once per run. If evidence is insufficient, the field stays `missing` and the agent moves on — it does not guess.

---

## No-fabrication guardrail

- All draft fields start as `{ status: "missing" }`
- Values become `{ status: "known", value, evidence?, sourceHint }` only when extractors find support in source text
- No LLM is used to invent clinical facts
- Pending results default to missing unless explicitly documented
- OCR-processed PDFs get a `review_flags` entry (`ocr_ingestion`)
- Output is always a **draft for review**, never auto-finalized

---

## PDF ingestion (text + scanned)

Two-stage pipeline in `src/pdf.js`:

1. **Text layer** — `unpdf` (PDF.js) for searchable PDFs
2. **OCR fallback** — when text is sparse: `extractImages` → `sharp` → `tesseract.js` per page

Pages are tagged `--- page N ---` for RAG chunking. OCR on large scans can take several minutes.

---

## RAG evidence grounding

After ingest, the agent builds a **local retrieval index** over patient documents only (`src/retrieval.js`, `src/ragExtract.js`):

1. Chunk text (page-aware, overlapping windows)
2. Retrieve top evidence per discharge field via lexical queries
3. Extract values from retrieved context only
4. Attach `evidence` snippets (file, page, score) to known fields
5. Flag conflicts when retrieved evidence disagrees

No external medical knowledge is injected.

---

## Failure and conflict handling

| Situation | Response |
|---|---|
| PDF read failure / timeout | Retry (×2), then `review_flags` ingestion failure |
| Tool failure | Flagged, loop continues |
| Runtime error on action | Flagged, loop continues |
| Conflicting diagnoses/dates | Flagged, not auto-resolved; escalation tool called |
| Evidence disagreement | Added to conflict set |
| Med added/stopped without reason | `medication_reconciliation` flag |
| Step cap reached | `step_cap_reached` flag, graceful stop |

Mock tools in `src/tools.js`: drug interaction lookup, clinician escalation, medication reconciliation.

---

## Part 2 — learning from simulated edits (stretch)

`src/learning.js` implements a lightweight feedback loop:

- **Simulated reviewer** applies hidden edit policies (safety language, med formatting, pending-results reminder)
- **Reward:** `1 - normalized_edit_distance(draft, edited)`
- **Learning:** correction-memory rules applied across epochs
- **Output:** `learning_report.json` with before/after metrics and improvement curve

This is a demonstrator — not production fine-tuning. Part 1 safety rules are not overridden.

---

## Project structure

| File | Role |
|---|---|
| `src/index.js` | CLI batch runner |
| `src/agent.js` | Agent loop, planning, actions, trace |
| `src/pdf.js` | PDF + OCR ingestion |
| `src/retrieval.js` | Chunking, lexical RAG index |
| `src/ragExtract.js` | Evidence-backed field extraction |
| `src/extractors.js` | Section regex parsers |
| `src/tools.js` | Retries, mock tools, med reconciliation |
| `src/learning.js` | Part 2 simulated learning |
| `src/learn_cli.js` | Part 2 CLI |

---

## Input layout

```text
input/patient_sources/
  patient_001.pdf
  patient_002.pdf
```

---

## Limitations

- Regex extractors struggle on noisy OCR output
- Single PDF may contain multiple patient records (evidence can mix)
- Conflict detection covers key fields, not all clinical dimensions
- Tools are mocked, not production APIs
- RAG is lexical (no embeddings yet)
- Part 2 uses simulated reviewer, not real clinician edits

---

## With more time

1. Patient-of-record filter before RAG indexing
2. Embedding-based retrieval (still case-only, no external facts)
3. Layout-aware / hospital-format-specific extractors
4. Real drug-interaction API integration
5. Citation-enforced LLM synthesis over retrieved chunks only
6. Part 2 with real edit logs and anti-gaming reward metrics

---

## License / data

Synthetic patient data only. Do not commit real PHI. API keys are not required for the current implementation.
