const path = require("path");
const {
  readPdfText,
  listPatientPdfFiles
} = require("./pdf");
const {
  extractDemographics,
  extractDates,
  extractDiagnoses,
  extractProcedures,
  extractAllergies,
  extractMedicationSections,
  extractHospitalCourse,
  extractFollowUp,
  extractPendingResults,
  extractDischargeCondition
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

function toKnown(value, sourceHint = null) {
  if (value == null) return mkMissing();
  if (Array.isArray(value) && value.length === 0) return mkMissing();
  if (typeof value === "object" && !Array.isArray(value)) {
    const hasAnyTruthy = Object.values(value).some((v) => {
      if (Array.isArray(v)) return v.length > 0;
      return v != null && `${v}`.trim() !== "";
    });
    if (!hasAnyTruthy) return mkMissing();
  }
  return { status: "known", value, sourceHint };
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

function detectConflicts(extractions) {
  const conflicts = [];

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

  return conflicts;
}

function buildReasoning(state) {
  const draft = state.draft;
  const missing = Object.entries(draft)
    .filter(([k, v]) => k !== "review_flags" && v?.status === "missing")
    .map(([k]) => k);

  if (missing.length) {
    return `Fill unresolved sections: ${missing.join(", ")}`;
  }
  if (!state.interactionChecked) return "Safety check medications for potential interactions";
  if (state.conflicts.length) return "Escalate unresolved conflicts for clinician review";
  return "Finalize draft output";
}

function planNextAction(state) {
  if (!state.loadedDocs) return "load_documents";
  if (state.draft.demographics.status === "missing") return "extract_demographics";
  if (state.draft.admission_discharge_dates.status === "missing") return "extract_dates";
  if (state.draft.principal_diagnoses.status === "missing") return "extract_diagnoses";
  if (state.draft.hospital_course.status === "missing") return "extract_hospital_course";
  if (state.draft.procedures.status === "missing") return "extract_procedures";
  if (state.draft.discharge_medications.status === "missing") return "extract_medications";
  if (state.draft.allergies.status === "missing") return "extract_allergies";
  if (state.draft.follow_up_instructions.status === "missing") return "extract_followup";
  if (state.draft.pending_results.status === "missing") return "extract_pending";
  if (state.draft.discharge_condition.status === "missing") return "extract_discharge_condition";
  if (!state.conflictsEvaluated) return "detect_conflicts";
  if (!state.interactionChecked) return "check_interactions";
  if (state.conflicts.length && !state.conflictsEscalated) return "escalate_conflicts";
  return "finalize";
}

function addTrace(state, step) {
  state.trace.push(step);
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
      parsedDocs.push({ file, text: result.result });
    } else {
      failures.push({ file, error: result.error });
    }
  }

  state.documents = parsedDocs;
  state.loadedDocs = true;

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

  return { loaded_count: parsedDocs.length, failures };
}

function combinedText(state) {
  return state.documents.map((d) => d.text).join("\n\n");
}

async function executeAction(state, action) {
  const text = combinedText(state);
  switch (action) {
    case "extract_demographics": {
      const d = extractDemographics(text);
      state.draft.demographics = toKnown(d, "all_documents");
      return d;
    }
    case "extract_dates": {
      const perDoc = state.documents.map((d) => extractDates(d.text));
      const admissionDates = mergeUnique([], perDoc.map((d) => d.admission_date).filter(Boolean));
      const dischargeDates = mergeUnique([], perDoc.map((d) => d.discharge_date).filter(Boolean));
      state.extractions.dates = { admission_date: admissionDates, discharge_date: dischargeDates };
      state.draft.admission_discharge_dates = toKnown(
        {
          admission_date: admissionDates[0] || null,
          discharge_date: dischargeDates[0] || null
        },
        "multiple_documents"
      );
      return state.extractions.dates;
    }
    case "extract_diagnoses": {
      const diagnoses = state.documents.map((d) => extractDiagnoses(d.text));
      const principal = mergeUnique([], diagnoses.flatMap((d) => d.principal || []));
      const secondary = mergeUnique([], diagnoses.flatMap((d) => d.secondary || []));
      state.extractions.diagnoses = { principal, secondary };
      state.draft.principal_diagnoses = toKnown(principal, "multiple_documents");
      state.draft.secondary_diagnoses = toKnown(secondary, "multiple_documents");
      return state.extractions.diagnoses;
    }
    case "extract_hospital_course": {
      const course = extractHospitalCourse(text);
      state.draft.hospital_course = toKnown(course, "all_documents");
      return course;
    }
    case "extract_procedures": {
      const procedures = mergeUnique([], state.documents.flatMap((d) => extractProcedures(d.text)));
      state.draft.procedures = toKnown(procedures, "multiple_documents");
      return procedures;
    }
    case "extract_medications": {
      const medSlices = state.documents.map((d) => extractMedicationSections(d.text));
      const admissionMeds = mergeUnique([], medSlices.flatMap((m) => m.admission_meds || []));
      const dischargeMeds = mergeUnique([], medSlices.flatMap((m) => m.discharge_meds || []));
      const reconciliation = reconcileMedications(admissionMeds, dischargeMeds);
      state.extractions.medications = { admissionMeds, dischargeMeds };
      state.draft.discharge_medications = toKnown(dischargeMeds, "multiple_documents");
      state.draft.medication_changes = toKnown(reconciliation, "calculated");

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
      return { dischargeMeds, reconciliation };
    }
    case "extract_allergies": {
      const allergies = mergeUnique([], state.documents.flatMap((d) => extractAllergies(d.text)));
      state.draft.allergies = toKnown(allergies, "multiple_documents");
      return allergies;
    }
    case "extract_followup": {
      const f = extractFollowUp(text);
      state.draft.follow_up_instructions = toKnown(f, "all_documents");
      return f;
    }
    case "extract_pending": {
      const pending = mergeUnique([], state.documents.flatMap((d) => extractPendingResults(d.text)));
      state.draft.pending_results = toKnown(pending, "multiple_documents");
      return pending;
    }
    case "extract_discharge_condition": {
      const cond = extractDischargeCondition(text);
      state.draft.discharge_condition = toKnown(cond, "all_documents");
      return cond;
    }
    case "detect_conflicts": {
      state.conflicts = detectConflicts(state.extractions);
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

async function runDischargeSummaryAgent({ patientId, patientDir, patientPdfFiles = null, maxSteps = 20 }) {
  const state = {
    patientId,
    patientDir,
    patientPdfFiles,
    documents: [],
    loadedDocs: false,
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
      conflicts_open: state.conflicts.length
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
