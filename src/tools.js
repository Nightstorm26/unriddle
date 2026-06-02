function normalizeMedName(line) {
  return line.toLowerCase().replace(/\s+/g, " ").trim();
}

async function withRetries({ toolName, args, fn, retries = 2, delayMs = 250 }) {
  let attempt = 0;
  let lastErr = null;
  while (attempt <= retries) {
    try {
      const result = await fn(args);
      return { ok: true, attempt: attempt + 1, result };
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      attempt += 1;
    }
  }
  return {
    ok: false,
    attempt: retries + 1,
    error: `${toolName} failed after retries: ${lastErr?.message || "unknown error"}`
  };
}

async function drugInteractionLookup({ dischargeMeds }) {
  const interactionPairs = [
    ["warfarin", "aspirin", "Bleeding risk increased"],
    ["lisinopril", "spironolactone", "Hyperkalemia risk increased"],
    ["metformin", "contrast", "Lactic acidosis risk with contrast procedures"]
  ];

  const meds = dischargeMeds.map(normalizeMedName);
  const findings = [];

  for (const [a, b, warning] of interactionPairs) {
    if (meds.some((m) => m.includes(a)) && meds.some((m) => m.includes(b))) {
      findings.push({ pair: [a, b], warning });
    }
  }

  return { interactions: findings };
}

async function escalateForClinicianReview({ reason, details }) {
  return {
    escalated: true,
    reason,
    details,
    timestamp: new Date().toISOString()
  };
}

function reconcileMedications(admissionMeds, dischargeMeds) {
  const admissionMap = new Map(admissionMeds.map((m) => [normalizeMedName(m), m]));
  const dischargeMap = new Map(dischargeMeds.map((m) => [normalizeMedName(m), m]));

  const added = [];
  const stopped = [];
  const unchangedOrChanged = [];

  for (const [norm, raw] of dischargeMap.entries()) {
    if (!admissionMap.has(norm)) added.push(raw);
    else unchangedOrChanged.push(raw);
  }

  for (const [norm, raw] of admissionMap.entries()) {
    if (!dischargeMap.has(norm)) stopped.push(raw);
  }

  return { added, stopped, unchangedOrChanged };
}

module.exports = {
  withRetries,
  drugInteractionLookup,
  escalateForClinicianReview,
  reconcileMedications
};
