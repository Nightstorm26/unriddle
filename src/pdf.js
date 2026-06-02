const fs = require("fs/promises");
const path = require("path");
const pdfParse = require("pdf-parse");

async function readPdfText(filePath, timeoutMs = 12000) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`PDF read timeout: ${filePath}`)), timeoutMs);
  });

  const read = (async () => {
    const buffer = await fs.readFile(filePath);
    const parsed = await pdfParse(buffer);
    if (!parsed?.text || !parsed.text.trim()) {
      throw new Error(`PDF extraction returned empty text: ${filePath}`);
    }
    return parsed.text;
  })();

  return Promise.race([read, timeout]);
}

async function listPatientPdfFiles(patientDir) {
  const entries = await fs.readdir(patientDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".pdf")
    .map((entry) => path.join(patientDir, entry.name));
}

module.exports = {
  readPdfText,
  listPatientPdfFiles
};
