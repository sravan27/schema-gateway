import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  stringToHex,
  zeroAddress
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, "..");
const artifactPath = path.join(packageDir, "artifacts", "SovereignPaywall.json");

if (!fs.existsSync(artifactPath)) {
  throw new Error("Artifact not found. Run `npm run compile -w packages/contracts` first.");
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const create2Deployer = getAddress(
  process.env.CREATE2_DEPLOYER ?? "0x4e59b44847b379578588920cA78FbF26c0B4956C"
);
const salt = keccak256(stringToHex(process.env.SALT ?? "schema-gateway-v1"));
const ownerAddress = getAddress(process.env.OWNER_ADDRESS ?? process.env.TREASURY_ADDRESS ?? zeroAddress);
const treasuryAddress = getAddress(process.env.TREASURY_ADDRESS ?? ownerAddress);
const nativeUnitsPerCredit = BigInt(process.env.NATIVE_UNITS_PER_CREDIT ?? "100000000000000");
const constructorArgs = encodeAbiParameters(
  [
    { type: "address" },
    { type: "address" },
    { type: "uint256" }
  ],
  [ownerAddress, treasuryAddress, nativeUnitsPerCredit]
);

const initCode = concatHex([artifact.bytecode, constructorArgs]);
const create2Hash = keccak256(
  concatHex([
    "0xff",
    create2Deployer,
    salt,
    keccak256(initCode)
  ])
);
const predictedAddress = getAddress(`0x${create2Hash.slice(-40)}`);

console.log(`Predicted address: ${predictedAddress}`);
console.log(`Salt: ${salt}`);
console.log(`CREATE2 deployer: ${create2Deployer}`);

if (process.argv.includes("--dry-run") || !process.env.RPC_URL || !process.env.PRIVATE_KEY) {
  console.log("Dry run only. Set RPC_URL and PRIVATE_KEY to broadcast the deployment.");
  process.exit(0);
}

const publicClient = createPublicClient({
  transport: http(process.env.RPC_URL)
});
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const walletClient = createWalletClient({
  account,
  transport: http(process.env.RPC_URL)
});

const hash = await walletClient.sendTransaction({
  account,
  to: create2Deployer,
  data: concatHex([salt, initCode])
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });

console.log(`Deployment tx: ${hash}`);
console.log(`Receipt status: ${receipt.status}`);
console.log(`Contract address: ${predictedAddress}`);
