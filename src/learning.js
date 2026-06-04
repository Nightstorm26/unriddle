const fs = require("fs/promises");
const path = require("path");

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function textify(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// function levenshtein(a, b) {
//   const m = a.length;
//   const n = b.length;
//   const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
//   for (let i = 0; i <= m; i += 1) dp[i][0] = i;
//   for (let j = 0; j <= n; j += 1) dp[0][j] = j;
//   for (let i = 1; i <= m; i += 1) {
//     for (let j = 1; j <= n; j += 1) {
//       const cost = a[i - 1] === b[j - 1] ? 0 : 1;
//       dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
//     }
//   }
//   return dp[m][n];
// }
function levenshtein(a, b) {
  // Guard: if either string is huge, use a length-based approximation
  const MAX_LEN = 100_000;
  if (a.length > MAX_LEN || b.length > MAX_LEN) {
    return Math.abs(a.length - b.length);
  }

  const m = a.length;
  const n = b.length;

  // Only keep two rows instead of the full m×n matrix
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev]; // swap rows
  }

  return prev[n];
}

// function normalizedEditDistance(a, b) {
//   const aa = textify(a);
//   const bb = textify(b);
//   const denom = Math.max(aa.length, bb.length, 1);
//   return levenshtein(aa, bb) / denom;
// }
function normalizedEditDistance(a, b) {
  const keysA = Object.keys(a);
  const keysB = new Set(Object.keys(b));
  const allKeys = [...new Set([...keysA, ...Object.keys(b)])];

  let totalDist = 0;
  let totalLen = 0;

  for (const key of allKeys) {
    const aa = textify(a[key]);
    const bb = textify(b[key]);
    const denom = Math.max(aa.length, bb.length, 1);
    totalDist += levenshtein(aa, bb);
    totalLen += denom;
  }

  return totalLen === 0 ? 0 : totalDist / totalLen;
}

function simulatedReviewerPolicy(draft) {
  const edited = clone(draft);
  const edits = [];

  if (edited.follow_up_instructions?.status === "known") {
    const old = edited.follow_up_instructions.value;
    const withSafety = `${old}. Return to ED for chest pain, dyspnea, syncope, or worsening symptoms.`;
    edited.follow_up_instructions.value = withSafety;
    edits.push("expanded follow-up safety language");
  }

  if (edited.discharge_medications?.status === "known") {
    const meds = edited.discharge_medications.value;
    const normalized = meds.map((m) => m.replace(/\s+/g, " ").trim());
    edited.discharge_medications.value = normalized;
    edits.push("normalized medication formatting");
  }

  if (edited.pending_results?.status === "missing") {
    edited.pending_results = {
      status: "known",
      value: ["No pending results explicitly documented in source notes (confirm with lab system)."],
      sourceHint: "simulated_reviewer_policy"
    };
    edits.push("added explicit pending-results clinician reminder");
  }

  return { edited, edits };
}

function applyCorrectionMemory(draft, memory) {
  const output = clone(draft);
  if (memory.addSafetyFollowUp && output.follow_up_instructions?.status === "known") {
    if (!output.follow_up_instructions.value.includes("Return to ED")) {
      output.follow_up_instructions.value +=
        ". Return to ED for chest pain, dyspnea, syncope, or worsening symptoms.";
    }
  }
  if (memory.normalizeMeds && output.discharge_medications?.status === "known") {
    output.discharge_medications.value = output.discharge_medications.value.map((m) =>
      m.replace(/\s+/g, " ").trim()
    );
  }
  if (memory.explicitNoPending && output.pending_results?.status === "missing") {
    output.pending_results = {
      status: "known",
      value: ["No pending results explicitly documented in source notes (confirm with lab system)."],
      sourceHint: "correction_memory"
    };
  }
  return output;
}

async function listDraftFiles(root) {
  const out = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      const target = path.join(p, "discharge_summary_draft.json");
      try {
        await fs.access(target);
        out.push(target);
      } catch (_) {
        // ignore
      }
    }
  }
  return out;
}

async function runLearningLoop({ draftsRoot, outputFile }) {
  const draftFiles = await listDraftFiles(draftsRoot);
  if (!draftFiles.length) {
    throw new Error(`No discharge_summary_draft.json files found in ${draftsRoot}`);
  }

  const memory = { addSafetyFollowUp: false, normalizeMeds: false, explicitNoPending: false };
  const curve = [];

  for (let epoch = 1; epoch <= 3; epoch += 1) {
    const scores = [];
    for (const f of draftFiles) {
      const raw = JSON.parse(await fs.readFile(f, "utf8"));
      const beforeDraft = applyCorrectionMemory(raw, memory);
      const reviewed = simulatedReviewerPolicy(beforeDraft).edited;
      const score = normalizedEditDistance(beforeDraft, reviewed);
      scores.push(score);
    }

    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    curve.push({ epoch, average_normalized_edit_distance: avg });

    if (epoch === 1) {
      memory.addSafetyFollowUp = true;
      memory.normalizeMeds = true;
    } else if (epoch === 2) {
      memory.explicitNoPending = true;
    }
  }

  const result = {
    reward_definition:
      "Reward = 1 - normalized_edit_distance(agent_draft, simulated_reviewer_edit). Higher is better.",
    correction_memory: memory,
    improvement_curve: curve,
    before_after: {
      before_epoch_1: curve[0].average_normalized_edit_distance,
      after_epoch_3: curve[curve.length - 1].average_normalized_edit_distance
    }
  };

  await fs.writeFile(outputFile, JSON.stringify(result, null, 2), "utf8");
  return result;
}

module.exports = {
  runLearningLoop
};
