function clean(value) {
  return value ? value.replace(/\s+/g, " ").trim() : null;
}

function firstMatch(text, regex) {
  const match = text.match(regex);
  return clean(match?.[1] ?? null);
}

function allMatches(text, regex) {
  return [...text.matchAll(regex)].map((m) => clean(m[1])).filter(Boolean);
}

function gatherSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}\\s*[:\\-]?\\s*([\\s\\S]{0,600})`, "i");
  const raw = firstMatch(text, regex);
  if (!raw) return null;
  const stop = raw.split(/\n\s*[A-Z][A-Za-z ]{2,}[:\-]/)[0];
  return clean(stop);
}

function extractDemographics(text) {
  return {
    patient_name: firstMatch(text, /(?:Patient Name|Name)\s*[:\-]\s*([^\n]+)/i),
    mrn: firstMatch(text, /\b(?:MRN|Medical Record Number)\s*[:\-]\s*([^\n]+)/i),
    dob: firstMatch(text, /\b(?:DOB|Date of Birth)\s*[:\-]\s*([^\n]+)/i),
    sex: firstMatch(text, /\b(?:Sex|Gender)\s*[:\-]\s*([^\n]+)/i)
  };
}

function extractDates(text) {
  return {
    admission_date: firstMatch(text, /Admission Date\s*[:\-]\s*([^\n]+)/i),
    discharge_date: firstMatch(text, /Discharge Date\s*[:\-]\s*([^\n]+)/i)
  };
}

function extractDiagnoses(text) {
  const principal = allMatches(
    text,
    /(?:Principal Diagnosis|Primary Diagnosis|Final Diagnosis|Discharge Diagnosis)\s*[:\-]\s*([^\n]+)/gi
  );
  if (!principal.length) {
    const fallback = firstMatch(text, /(?:Diagnosis|Diagnoses)\s*[:\-]\s*([^\n]+)/i);
    if (fallback) principal.push(fallback);
  }
  const secondary = allMatches(
    text,
    /(?:Secondary Diagnos(?:is|es)|Other Diagnos(?:is|es)|Comorbidit(?:y|ies))\s*[:\-]\s*([^\n]+)/gi
  );
  return { principal, secondary };
}

function extractProcedures(text) {
  const inline = allMatches(text, /(?:Procedure|Procedures)\s*[:\-]\s*([^\n]+)/gi);
  const section = gatherSection(text, "Procedures");
  return [...inline, ...(section ? [section] : [])];
}

function extractAllergies(text) {
  const inline = allMatches(text, /Allerg(?:y|ies)\s*[:\-]\s*([^\n]+)/gi);
  return inline.length ? inline : [];
}

function parseMeds(sectionText) {
  if (!sectionText) return [];
  return sectionText
    .split(/\n|;/)
    .map((line) => clean(line))
    .filter((line) => line && /[a-z]/i.test(line))
    .slice(0, 80);
}

function extractMedicationSections(text) {
  const admissionBlock =
    gatherSection(text, "Admission Medications") ||
    gatherSection(text, "Home Medications") ||
    gatherSection(text, "Medications on Admission") ||
    gatherSection(text, "Current Medications");
  const dischargeBlock =
    gatherSection(text, "Discharge Medications") ||
    gatherSection(text, "Medications on Discharge") ||
    gatherSection(text, "Discharge Rx") ||
    gatherSection(text, "Medications");

  return {
    admission_meds: parseMeds(admissionBlock),
    discharge_meds: parseMeds(dischargeBlock)
  };
}

function extractHospitalCourse(text) {
  return gatherSection(text, "Hospital Course");
}

function extractFollowUp(text) {
  return (
    gatherSection(text, "Follow-up Instructions") ||
    gatherSection(text, "Follow Up") ||
    gatherSection(text, "Advice on Discharge")
  );
}

function extractPendingResults(text) {
  return [...text.matchAll(/(?:Pending(?: Results?)?|Result Pending)\s*[:\-]\s*([^\n]+)/gi)]
    .map((m) => clean(m[1]))
    .filter(Boolean);
}

function extractDischargeCondition(text) {
  return firstMatch(text, /Discharge Condition\s*[:\-]\s*([^\n]+)/i);
}

module.exports = {
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
};
