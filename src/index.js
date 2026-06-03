const fs = require("fs/promises");
const path = require("path");
const { runDischargeSummaryAgent } = require("./agent");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[key] = value;
    }
  }
  return out;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function listPatientDirs(inputRoot) {
  const entries = await fs.readdir(inputRoot, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(inputRoot, e.name));
}

async function listPdfFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === ".pdf")
    .map((e) => path.join(dir, e.name));
}

async function buildPatientJobs(inputPath) {
  const stat = await fs.stat(inputPath);

  if (stat.isFile()) {
    if (path.extname(inputPath).toLowerCase() !== ".pdf") {
      throw new Error(`Input file must be a .pdf: ${inputPath}`);
    }
    const id = path.basename(inputPath, path.extname(inputPath)).replace(/[^\w\-]+/g, "_");
    return [{ patientId: id || "patient_single", patientDir: path.dirname(inputPath), patientPdfFiles: [inputPath] }];
  }

  const directPdfFiles = await listPdfFiles(inputPath);
  if (directPdfFiles.length) {
    const id = path.basename(inputPath).replace(/[^\w\-]+/g, "_");
    return [{ patientId: id || "patient_single", patientDir: inputPath, patientPdfFiles: directPdfFiles }];
  }

  const patientDirs = await listPatientDirs(inputPath);
  if (!patientDirs.length) {
    throw new Error(
      `No PDFs or patient folders found in ${inputPath}. Use one of: (1) a .pdf file, (2) a folder of PDFs, or (3) a folder of patient subfolders.`
    );
  }

  return patientDirs.map((pDir) => ({
    patientId: path.basename(pDir),
    patientDir: pDir,
    patientPdfFiles: null
  }));
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  const inputRoot = path.resolve(args.input || "./patients");
  const outputRoot = path.resolve(args.output || "./runs/latest");
  const maxSteps = Number(args.maxSteps || 35);

  await ensureDir(outputRoot);
  const patientJobs = await buildPatientJobs(inputRoot);

  const runSummary = [];
  for (const job of patientJobs) {
    const result = await runDischargeSummaryAgent({
      patientId: job.patientId,
      patientDir: job.patientDir,
      patientPdfFiles: job.patientPdfFiles,
      maxSteps
    });

    const patientOutDir = path.join(outputRoot, job.patientId);
    await ensureDir(patientOutDir);
    await writeJson(path.join(patientOutDir, "discharge_summary_draft.json"), result.draft);
    await writeJson(path.join(patientOutDir, "trace.json"), result.trace);
    runSummary.push({
      patient_id: job.patientId,
      output_dir: patientOutDir,
      review_flags: result.draft.review_flags.length
    });
  }

  await writeJson(path.join(outputRoot, "run_summary.json"), runSummary);
  console.log(`Run complete. Output written to: ${outputRoot}`);
}

main().catch((err) => {
  console.error(`Run failed: ${err.message}`);
  process.exitCode = 1;
});
