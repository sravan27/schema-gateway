import fs from "node:fs/promises";

const [lintPath, compilePath, summaryPath, schemaPath, diffPath] = process.argv.slice(2);

if (!lintPath || !compilePath || !summaryPath || !schemaPath) {
  process.stderr.write("Expected lint, compile, summary, and schema paths.\n");
  process.exit(1);
}

const lint = JSON.parse(await fs.readFile(lintPath, "utf8"));
const compiled = JSON.parse(await fs.readFile(compilePath, "utf8"));
const diff = diffPath ? JSON.parse(await fs.readFile(diffPath, "utf8")) : null;

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

if (diff) {
  lines.push("## Regression Check");
  lines.push("");
  lines.push(`Baseline hash: \`${diff.baselineHash}\``);
  lines.push(`Candidate hash: \`${diff.candidateHash}\``);
  lines.push(
    `Breaking change likely: **${diff.summary?.breakingChangeLikely ? "yes" : "no"}** | Introduced errors: **${diff.summary?.introducedErrorCount ?? 0}** | Introduced warnings: **${diff.summary?.introducedWarningCount ?? 0}** | Resolved issues: **${diff.summary?.resolvedIssueCount ?? 0}**`
  );

  if (Array.isArray(diff.summary?.affectedProviders) && diff.summary.affectedProviders.length > 0) {
    lines.push(`Affected providers: ${diff.summary.affectedProviders.map((provider) => `\`${provider}\``).join(", ")}`);
  }

  if (Array.isArray(diff.changeRisks) && diff.changeRisks.length > 0) {
    lines.push("");
    lines.push("Schema change risks:");
    for (const risk of diff.changeRisks.slice(0, 5)) {
      lines.push(`- \`${risk.code}\`: ${risk.message}`);
    }
  }

  for (const provider of diff.providers ?? []) {
    lines.push("");
    lines.push(`### ${provider.provider} regression view`);
    lines.push(
      `Baseline: **${provider.baselineScore}** | Candidate: **${provider.candidateScore}** | Delta: **${provider.scoreDelta}** | Introduced issues: **${provider.introducedIssues?.length ?? 0}** | Resolved issues: **${provider.resolvedIssues?.length ?? 0}**`
    );

    if (Array.isArray(provider.introducedIssues) && provider.introducedIssues.length > 0) {
      lines.push("");
      lines.push("New issues:");
      for (const issue of provider.introducedIssues.slice(0, 5)) {
        lines.push(`- \`${issue.code}\`: ${issue.message}`);
      }
    }
  }
}

await fs.writeFile(summaryPath, `${lines.join("\n")}\n`, "utf8");
