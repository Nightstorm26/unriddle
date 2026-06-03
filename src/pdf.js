const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

const MIN_MEANINGFUL_CHARS_PER_PAGE = 40;

let unpdfModulePromise = null;

function getUnpdf() {
  if (!unpdfModulePromise) {
    unpdfModulePromise = import("unpdf");
  }
  return unpdfModulePromise;
}

function meaningfulCharCount(text) {
  return (text || "").replace(/\s+/g, "").length;
}

function needsOcr(text, totalPages) {
  const pages = Math.max(totalPages, 1);
  const meaningful = meaningfulCharCount(text);
  return meaningful < pages * MIN_MEANINGFUL_CHARS_PER_PAGE;
}

async function extractTextLayer(buffer) {
  const { extractText, getDocumentProxy } = await getUnpdf();
  const data = new Uint8Array(buffer);
  const pdf = await getDocumentProxy(data);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { pdf, data, totalPages, text: text || "" };
}

async function imageToPngBuffer(image) {
  return sharp(image.data, {
    raw: {
      width: image.width,
      height: image.height,
      channels: image.channels
    }
  })
    .png()
    .toBuffer();
}

function pickLargestImage(images) {
  if (!images?.length) return null;
  return images.reduce((best, current) => {
    const bestArea = best.width * best.height;
    const currentArea = current.width * current.height;
    return currentArea > bestArea ? current : best;
  });
}

async function extractTextWithOcr(pdf, totalPages) {
  const { extractImages } = await getUnpdf();
  const worker = await createWorker("eng");
  const pageTexts = [];

  try {
    for (let page = 1; page <= totalPages; page += 1) {
      const images = await extractImages(pdf, page);
      const target = pickLargestImage(images);
      if (!target) {
        pageTexts.push("");
        continue;
      }

      const pngBuffer = await imageToPngBuffer(target);
      const { data: ocr } = await worker.recognize(pngBuffer);
      pageTexts.push(ocr.text || "");
    }
  } finally {
    await worker.terminate();
  }

  return pageTexts
    .map((pageText, idx) => `--- page ${idx + 1} ---\n${pageText || ""}`)
    .join("\n\n");
}

async function readPdfText(filePath, timeoutMs = 600000) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`PDF read timeout: ${filePath}`)), timeoutMs);
  });

  const read = (async () => {
    const buffer = await fs.readFile(filePath);
    const { pdf, totalPages, text } = await extractTextLayer(buffer);

    let finalText = text;
    let method = "text_layer";

    if (needsOcr(text, totalPages)) {
      method = "ocr";
      finalText = await extractTextWithOcr(pdf, totalPages);
    }

    if (!meaningfulCharCount(finalText)) {
      throw new Error(`PDF extraction returned empty text (${method}): ${filePath}`);
    }

    return { text: finalText.trim(), method, totalPages };
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
  listPatientPdfFiles,
  needsOcr,
  meaningfulCharCount
};
