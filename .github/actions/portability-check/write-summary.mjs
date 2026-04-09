import fs from "node:fs/promises";

const [lintPath, compilePath, summaryPath, schemaPath] = process.argv.slice(2);

if (!lintPath || !compilePath || !summaryPath || !schemaPath) {
  process.stderr.write("Expected lint, compile, summary, and schema paths.\n");
  process.exit(1);
}

const lint = JSON.parse(await fs.readFile(lintPath, "utf8"));
const compiled = JSON.parse(await fs.readFile(compilePath, "utf8"));

const lines = [
  "## Schema Gateway",
  "",
  `Schema: \`${schemaPath}\``,
  `Schema hash: \`${lint.schemaHash}\``,
  ""
];

for (const provider of lint.providers ?? []) {
  const issues = Array.isArray(provider.issues) ? provider.issues : [];
  const errorCount = issues.filter((issue) => issue?.severity === "error").length;
  const warningCount = issues.filter((issue) => issue?.severity === "warning").length;
  const infoCount = issues.filter((issue) => issue?.severity === "info").length;

  lines.push(`### ${provider.provider}`);
  lines.push(
    `Compatibility: **${provider.compatible ? "pass" : "needs changes"}** | Score: **${provider.score}** | Errors: **${errorCount}** | Warnings: **${warningCount}** | Info: **${infoCount}**`
  );

  if (issues.length > 0) {
    lines.push("");
    lines.push("Top issues:");
    for (const issue of issues.slice(0, 5)) {
      lines.push(`- \`${issue.code}\`: ${issue.message}`);
    }
  }

  const compiledProvider = (compiled.providers ?? []).find(
    (entry) => entry.provider === provider.provider
  );

  if (compiledProvider?.variants?.[0]?.requestBody) {
    lines.push("");
    lines.push(`First generated snippet: **${compiledProvider.variants[0].label}**`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(compiledProvider.variants[0].requestBody, null, 2));
    lines.push("```");
  }

  lines.push("");
}

await fs.writeFile(summaryPath, `${lines.join("\n")}\n`, "utf8");
