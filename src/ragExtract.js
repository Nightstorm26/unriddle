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
  retrieveForField,
  buildRetrievalContext,
  findEvidenceConflicts
} = require("./retrieval");

function extractFieldValue(fieldKey, contextText) {
  switch (fieldKey) {
    case "demographics":
      return extractDemographics(contextText);
    case "admission_discharge_dates":
      return extractDates(contextText);
    case "principal_diagnoses":
    case "secondary_diagnoses": {
      const d = extractDiagnoses(contextText);
      return fieldKey === "principal_diagnoses" ? d.principal : d.secondary;
    }
    case "hospital_course":
      return extractHospitalCourse(contextText);
    case "procedures":
      return extractProcedures(contextText);
    case "admission_medications":
      return extractMedicationSections(contextText).admission_meds;
    case "discharge_medications":
      return extractMedicationSections(contextText).discharge_meds;
    case "allergies":
      return extractAllergies(contextText);
    case "follow_up_instructions":
      return extractFollowUp(contextText);
    case "pending_results":
      return extractPendingResults(contextText);
    case "discharge_condition":
      return extractDischargeCondition(contextText);
    default:
      return null;
  }
}

function hasExtractedValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.values(value).some((v) => {
      if (Array.isArray(v)) return v.length > 0;
      return v != null && `${v}`.trim() !== "";
    });
  }
  return `${value}`.trim() !== "";
}

function extractWithRag(index, fieldKey, fallbackText) {
  const hits = retrieveForField(index, fieldKey);
  const context = buildRetrievalContext(hits);
  const primary = extractFieldValue(fieldKey, context);
  const usedEvidence = [...hits];

  if (!hasExtractedValue(primary) && fallbackText) {
    const fallbackValue = extractFieldValue(fieldKey, fallbackText);
    return {
      value: fallbackValue,
      evidence: usedEvidence,
      usedFallback: true
    };
  }

  const perHitValues = hits
    .slice(0, 4)
    .map((hit) => extractFieldValue(fieldKey, hit.snippet))
    .filter(hasExtractedValue);

  const conflict = findEvidenceConflicts(fieldKey, [primary, ...perHitValues]);

  return {
    value: primary,
    evidence: usedEvidence,
    conflict,
    usedFallback: false
  };
}

module.exports = {
  extractWithRag,
  extractFieldValue,
  hasExtractedValue
};
