import fs from "node:fs/promises";

const [reportPath] = process.argv.slice(2);

if (!reportPath) {
  process.stderr.write("Expected a lint report path.\n");
  process.exit(1);
}

const payload = JSON.parse(await fs.readFile(reportPath, "utf8"));
const hasErrors = Array.isArray(payload.providers)
  && payload.providers.some(
    (provider) => Array.isArray(provider.issues)
      && provider.issues.some((issue) => issue?.severity === "error")
  );

process.stdout.write(hasErrors ? "true\n" : "false\n");
