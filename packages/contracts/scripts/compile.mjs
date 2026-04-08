import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import solc from "solc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, "..");
const entryPath = path.join(packageDir, "contracts", "SovereignPaywall.sol");
const artifactsDir = path.join(packageDir, "artifacts");
const sources = {};

function parseImports(sourceCode) {
  const matches = [];
  const regex = /import\s+(?:[^"']+from\s+)?["']([^"']+)["'];/g;
  let result = regex.exec(sourceCode);

  while (result) {
    matches.push(result[1]);
    result = regex.exec(sourceCode);
  }

  return matches;
}

function resolveImport(parentPath, specifier) {
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(parentPath), specifier);
  }

  const candidates = [
    path.resolve(packageDir, "node_modules", specifier),
    path.resolve(packageDir, "../../node_modules", specifier)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve import "${specifier}" from "${parentPath}".`);
}

function normalizeSourceUnit(parentSourceUnit, specifier) {
  if (!parentSourceUnit || !specifier.startsWith(".")) {
    return specifier;
  }

  return path.posix.normalize(path.posix.join(path.posix.dirname(parentSourceUnit), specifier));
}

function addSource(filePath, sourceUnit) {
  if (sources[sourceUnit]) {
    return;
  }

  const sourceCode = fs.readFileSync(filePath, "utf8");
  sources[sourceUnit] = {
    content: sourceCode
  };

  for (const importedPath of parseImports(sourceCode)) {
    const childSourceUnit = normalizeSourceUnit(sourceUnit, importedPath);
    addSource(resolveImport(filePath, importedPath), childSourceUnit);
  }
}

const entryKey = "contracts/SovereignPaywall.sol";
addSource(entryPath, entryKey);
const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: {
      enabled: true,
      runs: 200
    },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"]
      }
    }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = output.errors ?? [];

for (const issue of errors) {
  console[issue.severity === "error" ? "error" : "warn"](issue.formattedMessage);
}

if (errors.some((issue) => issue.severity === "error")) {
  process.exitCode = 1;
  throw new Error("Solidity compilation failed.");
}

const contractOutput = output.contracts?.[entryKey]?.SovereignPaywall;
if (!contractOutput) {
  throw new Error("Compiled output did not include SovereignPaywall.");
}

fs.mkdirSync(artifactsDir, { recursive: true });
const artifactPath = path.join(artifactsDir, "SovereignPaywall.json");
fs.writeFileSync(
  artifactPath,
  JSON.stringify(
    {
      contractName: "SovereignPaywall",
      abi: contractOutput.abi,
      bytecode: `0x${contractOutput.evm.bytecode.object}`
    },
    null,
    2
  )
);

console.log(`Wrote ${artifactPath}`);
