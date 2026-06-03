const path = require("path");

const CHUNK_SIZE = 1400;
const CHUNK_OVERLAP = 180;
const DEFAULT_TOP_K = 6;

const FIELD_QUERIES = {
  demographics:
    "patient name MRN medical record number date of birth age sex gender PR number IP number",
  admission_discharge_dates: "admission date discharge date date of admission date of discharge",
  principal_diagnoses:
    "principal diagnosis primary diagnosis final diagnosis discharge diagnosis acute diagnosis",
  secondary_diagnoses: "secondary diagnosis comorbidity other diagnosis",
  hospital_course: "hospital course course in hospital brief hospital course clinical course treatment given",
  procedures: "procedure procedures surgery intervention performed",
  admission_medications:
    "admission medications home medications medications on admission current medications at admission",
  discharge_medications:
    "discharge medications medications on discharge discharge rx medicines at discharge",
  allergies: "allergy allergies drug allergy adverse reaction",
  follow_up_instructions: "follow up instructions advice on discharge outpatient review return visit",
  pending_results: "pending results result pending lab pending investigation awaited",
  discharge_condition: "discharge condition condition at discharge stable improved"
};

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function splitPages(text) {
  const markerRegex = /---\s*page\s*(\d+)\s*---/gi;
  const matches = [...text.matchAll(markerRegex)];
  if (!matches.length) {
    return [{ page: 1, text: (text || "").trim() }];
  }

  const pages = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const pageNum = Number(matches[i][1]) || i + 1;
    const body = text.slice(start, end).trim();
    if (body) pages.push({ page: pageNum, text: body });
  }
  return pages.length ? pages : [{ page: 1, text: (text || "").trim() }];
}

function chunkText(text, maxLen = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= maxLen) return [normalized];

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + maxLen, normalized.length);
    chunks.push(normalized.slice(start, end));
    if (end >= normalized.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

function buildChunksFromDocuments(documents) {
  const chunks = [];
  let id = 0;

  for (const doc of documents) {
    const file = path.basename(doc.file);
    const pages = splitPages(doc.text || "");

    for (const pageBlock of pages) {
      const pageChunks = chunkText(pageBlock.text);
      for (let i = 0; i < pageChunks.length; i += 1) {
        id += 1;
        chunks.push({
          id: `chunk_${id}`,
          file,
          page: pageBlock.page,
          part: pageChunks.length > 1 ? i + 1 : null,
          text: pageChunks[i],
          tokens: tokenize(pageChunks[i])
        });
      }
    }
  }

  return chunks;
}

function scoreChunk(chunk, queryTokens) {
  if (!queryTokens.length) return 0;
  const tokenSet = new Set(chunk.tokens);
  let overlap = 0;
  for (const q of queryTokens) {
    if (tokenSet.has(q)) overlap += 1;
  }
  const phraseBoost = chunk.text.toLowerCase().includes(queryTokens.slice(0, 3).join(" ")) ? 1.5 : 0;
  const density = overlap / Math.sqrt(Math.max(chunk.tokens.length, 1));
  return overlap + density + phraseBoost;
}

function search(index, query, topK = DEFAULT_TOP_K) {
  const queryTokens = tokenize(query);
  const ranked = index.chunks
    .map((chunk) => ({
      chunkId: chunk.id,
      file: chunk.file,
      page: chunk.page,
      part: chunk.part,
      snippet: chunk.text.slice(0, 500),
      score: scoreChunk(chunk, queryTokens)
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return ranked;
}

function buildIndex(documents) {
  const chunks = buildChunksFromDocuments(documents);
  return {
    chunkCount: chunks.length,
    chunks
  };
}

function retrieveForField(index, fieldKey, topK = DEFAULT_TOP_K) {
  const query = FIELD_QUERIES[fieldKey];
  if (!query || !index?.chunks?.length) return [];
  return search(index, query, topK);
}

function buildRetrievalContext(hits, maxChars = 6000) {
  let used = 0;
  const parts = [];
  for (const hit of hits) {
    const block = `[${hit.file} p.${hit.page}] ${hit.snippet}`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

function normalizeForCompare(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((v) => `${v}`.toLowerCase().trim()).sort().join("|");
  if (typeof value === "object") {
    return JSON.stringify(value, Object.keys(value).sort());
  }
  return `${value}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function findEvidenceConflicts(fieldKey, values) {
  const normalized = values.map(normalizeForCompare).filter(Boolean);
  const unique = [...new Set(normalized)];
  if (unique.length <= 1) return null;
  return {
    field: fieldKey,
    message: `Conflicting evidence retrieved for ${fieldKey}`,
    values
  };
}

module.exports = {
  FIELD_QUERIES,
  buildIndex,
  search,
  retrieveForField,
  buildRetrievalContext,
  buildChunksFromDocuments,
  findEvidenceConflicts
};
