import fs from "node:fs/promises";

const [reportPath] = process.argv.slice(2);

if (!reportPath) {
  process.stdout.write("false\n");
  process.exit(0);
}

const payload = JSON.parse(await fs.readFile(reportPath, "utf8"));
const hasRegressions = Boolean(payload?.summary?.breakingChangeLikely);

process.stdout.write(hasRegressions ? "true\n" : "false\n");
