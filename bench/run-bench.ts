import fs from "node:fs/promises";
import path from "node:path";

import { normalizeStructuredOutput, type NormalizeRequest } from "@apex-value/schema-gateway";

type BenchCase = NormalizeRequest & {
  name: string;
  expectValid: boolean;
  note: string;
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function main(): Promise<void> {
  const casesPath = path.resolve(process.cwd(), "bench/cases.json");
  const raw = await fs.readFile(casesPath, "utf8");
  const cases = JSON.parse(raw) as BenchCase[];

  const lines = [
    "# Schema Gateway Benchmark",
    "",
    "| Case | Provider | Valid | Repaired | Extracted | Issues | Note |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  ];

  let passed = 0;
  for (const testCase of cases) {
    const result = await normalizeStructuredOutput(testCase);
    if (result.valid === testCase.expectValid) {
      passed += 1;
    }

    lines.push(
      `| ${escapeCell(testCase.name)} | ${testCase.provider ?? "generic"} | ${result.valid ? "yes" : "no"} | ${result.repaired ? "yes" : "no"} | ${result.extractedJson ? "yes" : "no"} | ${result.issues.length} | ${escapeCell(testCase.note)} |`
    );
  }

  lines.push("");
  lines.push(`Passed expectation check for ${passed}/${cases.length} cases.`);

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
