const path = require("path");
const { runLearningLoop } = require("./learning");

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

async function main() {
  const args = parseArgs(process.argv);
  const draftsRoot = path.resolve(args.drafts || "./runs/latest");
  const out = path.resolve(args.out || "./runs/latest/learning_report.json");
  const result = await runLearningLoop({ draftsRoot, outputFile: out });
  console.log("Learning loop complete.");
  console.log(JSON.stringify(result.before_after, null, 2));
}

main().catch((err) => {
  console.error(`Learning run failed: ${err.message}`);
  process.exitCode = 1;
});
