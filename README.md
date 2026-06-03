# Discharge Summary Agent

This project implements an **agentic discharge-summary drafting system** for synthetic patient PDFs.
It is designed for clinician review workflows and enforces a strict **no-fabrication** policy.

## What is implemented

### Part 1 (required): completed

- Real iterative agent loop with planning + re-planning (`runDischargeSummaryAgent` in `src/agent.js`)
- **RAG evidence retrieval** over ingested source notes only (`src/retrieval.js`, `src/ragExtract.js`)
- PDF ingestion from patient folders (`src/pdf.js`)
- Structured discharge-summary draft output with required sections
- No fabrication guardrail:
  - Missing fields are emitted as `{ status: "missing", reason: ... }`
  - Unknown values are never guessed
- Pending/missing data surfaced explicitly
- Medication reconciliation:
  - compares admission vs discharge meds
  - flags add/stop changes for clinician reconciliation if no reason documented
- Conflict handling:
  - detects conflicting principal diagnoses and discharge dates
  - flags for clinician review, does not auto-resolve
- Tool use with agent-decided timing:
  - mock drug interaction lookup
  - mock clinician escalation tool
- Robust failure handling:
  - retries on PDF/tool failures
  - emits review flags instead of crashing
- Hard control cap (`maxSteps`, default 20)
- Observability:
  - step trace includes reasoning -> action -> input -> result/error -> next

### Part 2 (stretch): included as a lightweight demonstrator

- Simulated reviewer with hidden edit policy (`simulatedReviewerPolicy` in `src/learning.js`)
- Reward definition:
  - `reward = 1 - normalized_edit_distance(draft, edited)`
- Learning mechanism:
  - correction-memory rules learned over epochs and injected into future drafts
- Before/after measurable metric:
  - outputs improvement curve in `learning_report.json`

## Project structure

- `src/index.js` - CLI runner for Part 1 batch execution
- `src/agent.js` - core agent loop and planning/actions
- `src/retrieval.js` - chunking + lexical retrieval index (case PDFs only)
- `src/ragExtract.js` - evidence-backed field extraction from retrieved chunks
- `src/pdf.js` - PDF listing and extraction with timeout handling
- `src/extractors.js` - section extraction helpers
- `src/tools.js` - mock tools + retry wrapper + med reconciliation
- `src/learning.js` - stretch learning loop
- `src/learn_cli.js` - CLI runner for stretch loop

## Input format

Place patient data like:

```text
patients/
  patient_001/
    admission_note.pdf
    progress_note_1.pdf
    labs.pdf
    med_rec.pdf
  patient_002/
    ...
```

Recommended (workspace-local) setup:

```text
input/
  patient_sources/
    patient_001.pdf
    patient_002.pdf
```

Keep your source PDFs inside this workspace so runs are reproducible and portable.

The runner also supports:

- A **single PDF file** (one patient)
- A **single folder containing PDFs** (one patient)
- A **folder of patient subfolders** (multi-patient batch)

## Run instructions

1. Install dependencies:

```bash
npm install
```

2. Run Part 1 agent:

```bash
npm start -- --input ./patients --output ./runs/latest --maxSteps 20
```

Workspace-local single file:

```bash
npm start -- --input "./input/patient_sources/patient_001.pdf" --output ./runs/latest --maxSteps 20
```

Workspace-local folder of PDFs:

```bash
npm start -- --input "./input/patient_sources" --output ./runs/latest --maxSteps 20
```

Single-file mode example (Windows path with spaces):

```bash
npm start -- --input "C:\Users\Aryan\Downloads\patient 2 (1).pdf" --output ./runs/latest --maxSteps 20
```

3. (Optional) Run Part 2 learning loop on generated drafts:

```bash
npm run learn -- --drafts ./runs/latest --out ./runs/latest/learning_report.json
```

## Outputs

For each patient:

- `runs/<run_name>/<patient_id>/discharge_summary_draft.json`
- `runs/<run_name>/<patient_id>/trace.json`

Run-level:

- `runs/<run_name>/run_summary.json`

Optional Part 2:

- `runs/<run_name>/learning_report.json`

## Safety notes

- This is a drafting assistant only; no auto-finalized clinical document.
- Missing, pending, and conflicting facts are always escalated/flagged.
- Drug interaction and escalation tools are mocked and can be replaced with production integrations.

## PDF ingestion (text + scanned)

The project uses a **two-stage strategy**:

1. **Fast text-layer extraction** with `unpdf` (PDF.js-based).
2. **OCR fallback** for scanned/image PDFs when extracted text is too sparse:
   - `unpdf` `extractImages` pulls embedded page images
   - `sharp` converts raw pixels to PNG
   - `tesseract.js` performs OCR per page

### Why not `pdf-text-extract`?

`pdf-text-extract` wraps Poppler `pdftotext` and is strong for searchable PDFs on Linux servers, but:

- it still does **not OCR scanned pages** by itself
- it requires external Poppler binaries (extra setup on Windows/serverless)
- your current patient PDF is image-based, so OCR fallback is required anyway

For this assignment and Windows-local workflow, **`unpdf + OCR fallback` is the better fit**.

Run locally:

```bash
npm start -- --input "./input/patient_sources/patient 2 (1).pdf" --output ./runs/latest --maxSteps 20
```

Note: OCR can take several minutes for multi-page scans.

## RAG workflow (agentic evidence grounding)

After PDF ingest, the agent:

1. Chunks each patient's source text (page-aware, overlap windows)
2. Builds a local lexical retrieval index (no external medical knowledge)
3. For each discharge field, retrieves top evidence chunks via field-specific queries
4. Extracts values only from retrieved context (+ full-document fallback if no evidence)
5. Attaches `evidence` snippets to known fields in `discharge_summary_draft.json`
6. Flags conflicts when retrieved evidence disagrees

Safety rule preserved: if evidence is insufficient, field remains `missing` (never guessed).

## Limits and next improvements

- Extraction uses regex heuristics and can be improved with section classifiers on top of OCR text.
- Conflict detection currently targets common high-risk conflicts; can be expanded.
- Part 2 uses simulated edits and correction memory (not model fine-tuning).
