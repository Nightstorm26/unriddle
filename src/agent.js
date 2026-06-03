const path = require("path");
const {
  readPdfText,
  listPatientPdfFiles
} = require("./pdf");
const { buildIndex } = require("./retrieval");
const { extractWithRag, hasExtractedValue } = require("./ragExtract");
const {
  extractDates,
  extractDiagnoses
} = require("./extractors");
const {
  withRetries,
  drugInteractionLookup,
  escalateForClinicianReview,
  reconcileMedications
} = require("./tools");

function mkMissing(reason = "Missing from source notes") {
  return { status: "missing", reason };
}

function toKnown(value, sourceHint = null, evidence = []) {
  if (value == null) return mkMissing();
  if (Array.isArray(value) && value.length === 0) return mkMissing();
  if (typeof value === "object" && !Array.isArray(value)) {
    const hasAnyTruthy = Object.values(value).some((v) => {
      if (Array.isArray(v)) return v.length > 0;
      return v != null && `${v}`.trim() !== "";
    });
    if (!hasAnyTruthy) return mkMissing();
  }
  const out = { status: "known", value, sourceHint: sourceHint || "rag" };
  if (evidence?.length) out.evidence = evidence;
  return out;
}

function initialDraft(patientId) {
  return {
    patient_id: patientId,
    demographics: mkMissing(),
    admission_discharge_dates: mkMissing(),
    principal_diagnoses: mkMissing(),
    secondary_diagnoses: mkMissing(),
    hospital_course: mkMissing(),
    procedures: mkMissing(),
    discharge_medications: mkMissing(),
    medication_changes: mkMissing(),
    allergies: mkMissing(),
    follow_up_instructions: mkMissing(),
    pending_results: mkMissing("No pending results documented"),
    discharge_condition: mkMissing(),
    review_flags: []
  };
}

function mergeUnique(current, incoming) {
  const set = new Set([...(current || []), ...(incoming || [])].map((v) => `${v}`.trim()).filter(Boolean));
  return [...set];
}

function detectConflicts(extractions, evidenceConflicts = []) {
  const conflicts = [...evidenceConflicts];

  const principal = mergeUnique([], extractions.diagnoses.principal || []);
  if (principal.length > 1) {
    conflicts.push({
      field: "principal_diagnoses",
      message: "Conflicting principal diagnoses across documents",
      values: principal
    });
  }

  const dischargeDates = mergeUnique([], extractions.dates.discharge_date || []);
  if (dischargeDates.length > 1) {
    conflicts.push({
      field: "admission_discharge_dates",
      message: "Conflicting discharge dates across documents",
      values: dischargeDates
    });
  }

  const seen = new Set();
  return conflicts.filter((c) => {
    const key = `${c.field}:${JSON.stringify(c.values)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildReasoning(state) {
  const draft = state.draft;
  const missing = Object.entries(draft)
    .filter(([k, v]) => k !== "review_flags" && v?.status === "missing")
    .map(([k]) => k);

  if (!state.ragBuilt) return "Index source-note chunks for evidence retrieval (RAG)";
  if (missing.length) {
    return `Retrieve evidence and fill unresolved sections: ${missing.join(", ")}`;
  }
  if (!state.interactionChecked) return "Safety check medications for potential interactions";
  if (state.conflicts.length) return "Escalate unresolved conflicts for clinician review";
  return "Finalize draft output";
}

function needsExtraction(state, fieldKey, draftKey = fieldKey) {
  return state.draft[draftKey]?.status === "missing" && !state.fieldAttempts[fieldKey];
}

function markAttempted(state, fieldKey) {
  state.fieldAttempts[fieldKey] = true;
}

function planNextAction(state) {
  if (!state.loadedDocs) return "load_documents";
  if (!state.ragBuilt) return "build_rag_index";
  if (needsExtraction(state, "demographics")) return "extract_demographics";
  if (needsExtraction(state, "admission_discharge_dates", "admission_discharge_dates")) return "extract_dates";
  if (needsExtraction(state, "principal_diagnoses")) return "extract_diagnoses";
  if (needsExtraction(state, "hospital_course")) return "extract_hospital_course";
  if (needsExtraction(state, "procedures")) return "extract_procedures";
  if (needsExtraction(state, "discharge_medications")) return "extract_medications";
  if (needsExtraction(state, "allergies")) return "extract_allergies";
  if (needsExtraction(state, "follow_up_instructions")) return "extract_followup";
  if (needsExtraction(state, "pending_results")) return "extract_pending";
  if (needsExtraction(state, "discharge_condition")) return "extract_discharge_condition";
  if (!state.conflictsEvaluated) return "detect_conflicts";
  if (!state.interactionChecked) return "check_interactions";
  if (state.conflicts.length && !state.conflictsEscalated) return "escalate_conflicts";
  return "finalize";
}

function addTrace(state, step) {
  state.trace.push(step);
}

function combinedText(state) {
  return state.documents.map((d) => d.text).join("\n\n");
}

function recordEvidenceConflict(state, conflict) {
  if (!conflict) return;
  state.evidenceConflicts.push(conflict);
}

async function actionLoadDocuments(state) {
  const files = state.patientPdfFiles?.length
    ? state.patientPdfFiles
    : await listPatientPdfFiles(state.patientDir);
  const parsedDocs = [];
  const failures = [];

  for (const file of files) {
    const result = await withRetries({
      toolName: "read_pdf_text",
      args: { file },
      fn: ({ file: fp }) => readPdfText(fp)
    });
    if (result.ok) {
      const payload = result.result;
      const text = typeof payload === "string" ? payload : payload.text;
      const extraction =
        typeof payload === "object" && payload
          ? { method: payload.method, totalPages: payload.totalPages }
          : { method: "unknown" };
      parsedDocs.push({ file, text, extraction });
    } else {
      failures.push({ file, error: result.error });
    }
  }

  state.documents = parsedDocs;
  state.loadedDocs = true;

  if (parsedDocs.some((d) => d.extraction?.method === "ocr")) {
    state.draft.review_flags.push({
      severity: "medium",
      type: "ocr_ingestion",
      message:
        "Source PDF was processed with OCR; extracted values may contain recognition errors and require clinician verification."
    });
  }

  if (!parsedDocs.length) {
    state.draft.review_flags.push({
      severity: "high",
      type: "ingestion_failure",
      message: "No readable PDFs were ingested; draft is incomplete."
    });
  }

  for (const fail of failures) {
    state.draft.review_flags.push({
      severity: "high",
      type: "ingestion_failure",
      message: `Failed to parse ${path.basename(fail.file)}: ${fail.error}`
    });
  }

  return {
    loaded_count: parsedDocs.length,
    failures,
    extractions: parsedDocs.map((d) => ({
      file: path.basename(d.file),
      method: d.extraction?.method,
      pages: d.extraction?.totalPages,
      chars: d.text?.length || 0
    }))
  };
}

function actionBuildRagIndex(state) {
  state.ragIndex = buildIndex(state.documents);
  state.ragBuilt = true;
  return {
    chunk_count: state.ragIndex.chunkCount,
    message: "RAG index built from patient source notes only (no external knowledge)."
  };
}

async function executeAction(state, action) {
  const fallbackText = combinedText(state);

  switch (action) {
    case "build_rag_index":
      return actionBuildRagIndex(state);
    case "extract_demographics": {
      const rag = extractWithRag(state.ragIndex, "demographics", fallbackText);
      recordEvidenceConflict(state, rag.conflict);
      state.draft.demographics = toKnown(rag.value, rag.usedFallback ? "full_document_fallback" : "rag", rag.evidence);
      markAttempted(state, "demographics");
      return rag;
    }
    case "extract_dates": {
      const rag = extractWithRag(state.ragIndex, "admission_discharge_dates", fallbackText);
      recordEvidenceConflict(state, rag.conflict);

      const perDoc = state.documents.map((d) => extractDates(d.text));
      const admissionDates = mergeUnique(
        [],
        [rag.value?.admission_date, ...perDoc.map((d) => d.admission_date)].filter(Boolean)
      );
      const dischargeDates = mergeUnique(
        [],
        [rag.value?.discharge_date, ...perDoc.map((d) => d.discharge_date)].filter(Boolean)
      );
      state.extractions.dates = { admission_date: admissionDates, discharge_date: dischargeDates };
      state.draft.admission_discharge_dates = toKnown(
        {
          admission_date: admissionDates[0] || null,
          discharge_date: dischargeDates[0] || null
        },
        rag.usedFallback ? "full_document_fallback" : "rag",
        rag.evidence
      );
      markAttempted(state, "admission_discharge_dates");
      return { rag, dates: state.extractions.dates };
    }
    case "extract_diagnoses": {
      const principalRag = extractWithRag(state.ragIndex, "principal_diagnoses", fallbackText);
      const secondaryRag = extractWithRag(state.ragIndex, "secondary_diagnoses", fallbackText);
      recordEvidenceConflict(state, principalRag.conflict);
      recordEvidenceConflict(state, secondaryRag.conflict);

      const diagnoses = state.documents.map((d) => extractDiagnoses(d.text));
      const principal = mergeUnique(
        [],
        [...(principalRag.value || []), ...diagnoses.flatMap((d) => d.principal || [])]
      );
      const secondary = mergeUnique(
        [],
        [...(secondaryRag.value || []), ...diagnoses.flatMap((d) => d.secondary || [])]
      );
      state.extractions.diagnoses = { principal, secondary };
      state.draft.principal_diagnoses = toKnown(
        principal,
        principalRag.usedFallback ? "full_document_fallback" : "rag",
        principalRag.evidence
      );
      state.draft.secondary_diagnoses = toKnown(
        secondary,
        secondaryRag.usedFallback ? "full_document_fallback" : "rag",
        secondaryRag.evidence
      );
      markAttempted(state, "principal_diagnoses");
      return state.extractions.diagnoses;
    }
    case "extract_hospital_course": {
      const rag = extractWithRag(state.ragIndex, "hospital_course", fallbackText);
      recordEvidenceConflict(state, rag.conflict);
      state.draft.hospital_course = toKnown(
        rag.value,
        rag.usedFallback ? "full_document_fallback" : "rag",
        rag.evidence
      );
      markAttempted(state, "hospital_course");
      return rag;
    }
    case "extract_procedures": {
      const rag = extractWithRag(state.ragIndex, "procedures", fallbackText);
      recordEvidenceConflict(state, rag.conflict);
      state.draft.procedures = toKnown(
        rag.value,
        rag.usedFallback ? "full_document_fallback" : "rag",
        rag.evidence
      );
      markAttempted(state, "procedures");
      return rag;
    }
    case "extract_medications": {
      const admissionRag = extractWithRag(state.ragIndex, "admission_medications", fallbackText);
      const dischargeRag = extractWithRag(state.ragIndex, "discharge_medications", fallbackText);
      recordEvidenceConflict(state, admissionRag.conflict);
      recordEvidenceConflict(state, dischargeRag.conflict);

      const admissionMeds = admissionRag.value || [];
      const dischargeMeds = dischargeRag.value || [];
      const reconciliation = reconcileMedications(admissionMeds, dischargeMeds);
      state.extractions.medications = { admissionMeds, dischargeMeds };
      state.draft.discharge_medications = toKnown(
        dischargeMeds,
        dischargeRag.usedFallback ? "full_document_fallback" : "rag",
        dischargeRag.evidence
      );
      state.draft.medication_changes = toKnown(reconciliation, "calculated", [
        ...admissionRag.evidence.slice(0, 2),
        ...dischargeRag.evidence.slice(0, 2)
      ]);

      const undocumentedChanges = [
        ...reconciliation.added.map((m) => ({ kind: "added", medication: m })),
        ...reconciliation.stopped.map((m) => ({ kind: "stopped", medication: m }))
      ];
      if (undocumentedChanges.length) {
        state.draft.review_flags.push({
          severity: "medium",
          type: "medication_reconciliation",
          message: "Medication changes require documented reason review",
          details: undocumentedChanges
        });
      }
      markAttempted(state, "discharge_medications");
      return { admissionMeds, dischargeMeds, reconciliation };
    }
    case "extract_allergies": {
      const rag = extractWithRag(state.ragIndex, "allergies", fallbackText);
      recordEvidenceConflict(state, rag.conflict);
      state.draft.allergies = toKnown(rag.value, rag.usedFallback ? "full_document_fallback" : "rag", rag.evidence);
      markAttempted(state, "allergies");
      return rag;
    }
    case "extract_followup": {
      const rag = extractWithRag(state.ragIndex, "follow_up_instructions", fallbackText);
      recordEvidenceConflict(state, rag.conflict);
      state.draft.follow_up_instructions = toKnown(
        rag.value,
        rag.usedFallback ? "full_document_fallback" : "rag",
        rag.evidence
      );
      markAttempted(state, "follow_up_instructions");
      return rag;
    }
    case "extract_pending": {
      const rag = extractWithRag(state.ragIndex, "pending_results", fallbackText);
      recordEvidenceConflict(state, rag.conflict);
      const pending = hasExtractedValue(rag.value) ? rag.value : null;
      state.draft.pending_results = pending
        ? toKnown(pending, rag.usedFallback ? "full_document_fallback" : "rag", rag.evidence)
        : mkMissing("No pending results documented");
      markAttempted(state, "pending_results");
      return rag;
    }
    case "extract_discharge_condition": {
      const rag = extractWithRag(state.ragIndex, "discharge_condition", fallbackText);
      recordEvidenceConflict(state, rag.conflict);
      state.draft.discharge_condition = toKnown(
        rag.value,
        rag.usedFallback ? "full_document_fallback" : "rag",
        rag.evidence
      );
      markAttempted(state, "discharge_condition");
      return rag;
    }
    case "detect_conflicts": {
      state.conflicts = detectConflicts(state.extractions, state.evidenceConflicts);
      state.conflictsEvaluated = true;
      for (const conflict of state.conflicts) {
        state.draft.review_flags.push({
          severity: "high",
          type: "conflict",
          message: conflict.message,
          details: conflict
        });
      }
      return state.conflicts;
    }
    case "check_interactions": {
      const dischargeMeds = state.extractions.medications.dischargeMeds || [];
      const result = await withRetries({
        toolName: "drug_interaction_lookup",
        args: { dischargeMeds },
        fn: drugInteractionLookup
      });
      state.interactionChecked = true;
      if (!result.ok) {
        state.draft.review_flags.push({
          severity: "high",
          type: "tool_failure",
          message: result.error
        });
        return result;
      }
      if (result.result.interactions.length) {
        state.draft.review_flags.push({
          severity: "high",
          type: "drug_interaction",
          message: "Potential interaction(s) found",
          details: result.result.interactions
        });
      }
      return result.result;
    }
    case "escalate_conflicts": {
      const escalation = await withRetries({
        toolName: "escalate_for_clinician_review",
        args: {
          reason: "Conflicting discharge summary data",
          details: state.conflicts
        },
        fn: escalateForClinicianReview
      });
      state.conflictsEscalated = true;
      return escalation;
    }
    case "load_documents":
      return actionLoadDocuments(state);
    case "finalize":
      return { status: "done" };
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function runDischargeSummaryAgent({ patientId, patientDir, patientPdfFiles = null, maxSteps = 35 }) {
  const state = {
    patientId,
    patientDir,
    patientPdfFiles,
    documents: [],
    loadedDocs: false,
    ragBuilt: false,
    ragIndex: null,
    fieldAttempts: {},
    evidenceConflicts: [],
    conflictsEvaluated: false,
    interactionChecked: false,
    conflictsEscalated: false,
    conflicts: [],
    trace: [],
    draft: initialDraft(patientId),
    extractions: {
      diagnoses: { principal: [], secondary: [] },
      dates: { admission_date: [], discharge_date: [] },
      medications: { admissionMeds: [], dischargeMeds: [] }
    }
  };

  for (let stepNo = 1; stepNo <= maxSteps; stepNo += 1) {
    const reasoning = buildReasoning(state);
    const action = planNextAction(state);
    const inputSnapshot = {
      missing_fields: Object.entries(state.draft)
        .filter(([k, v]) => k !== "review_flags" && v?.status === "missing")
        .map(([k]) => k),
      conflicts_open: state.conflicts.length,
      rag_ready: state.ragBuilt,
      rag_chunks: state.ragIndex?.chunkCount || 0
    };
    let output;
    let error = null;
    try {
      output = await executeAction(state, action);
    } catch (err) {
      error = `${err.message}`;
      state.draft.review_flags.push({
        severity: "high",
        type: "runtime_failure",
        message: `Action ${action} failed: ${error}`
      });
    }

    addTrace(state, {
      step: stepNo,
      reasoning,
      action,
      input: inputSnapshot,
      result: output || null,
      error,
      next: action === "finalize" ? "stop" : "re-plan"
    });

    if (action === "finalize") break;
    if (stepNo === maxSteps) {
      state.draft.review_flags.push({
        severity: "high",
        type: "step_cap_reached",
        message: `Agent stopped after maxSteps=${maxSteps}`
      });
    }
  }

  return {
    patient_id: patientId,
    draft: state.draft,
    trace: state.trace
  };
}

module.exports = {
  runDischargeSummaryAgent
};
