import fs from "node:fs/promises";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { extractImages, extractText, getDocumentProxy } from "unpdf";

const pdfPath = "input/patient_sources/patient 2 (1).pdf";
const buffer = await fs.readFile(pdfPath);
const data = new Uint8Array(buffer);
const pdf = await getDocumentProxy(data);
const { totalPages, text } = await extractText(pdf, { mergePages: true });
console.log("unpdf text chars:", text.replace(/\s+/g, " ").trim().length);

const worker = await createWorker("eng");
let all = "";
for (let page = 1; page <= totalPages; page += 1) {
  const images = await extractImages(pdf, page);
  const best = images.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!best) continue;
  const png = await sharp(best.data, {
    raw: { width: best.width, height: best.height, channels: best.channels }
  })
    .png()
    .toBuffer();
  const { data: ocr } = await worker.recognize(png);
  all += `\n\n--- page ${page} ---\n\n${ocr.text}`;
}
await worker.terminate();
const clean = all.replace(/\s+/g, " ").trim();
console.log("ocr total chars:", clean.length);
console.log("ocr preview:", clean.slice(0, 300));
