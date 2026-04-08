import { stableStringify } from "./utils.js";

const encoder = new TextEncoder();

function normalizeInput(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (typeof value === "string") {
    return encoder.encode(value);
  }

  return encoder.encode(stableStringify(value));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `0x${hex}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("base64");
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256Hex(value: unknown): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(normalizeInput(value)));
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacHex(secret: string, value: unknown): Promise<`0x${string}`> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, toArrayBuffer(normalizeInput(value)));
  return bytesToHex(new Uint8Array(signature));
}

export async function createSignedEnvelope(
  secret: string,
  payload: unknown
): Promise<`0x${string}`> {
  return hmacHex(secret, payload);
}

export function randomToken(bytes = 24): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToBase64Url(random);
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return result === 0;
}

export async function buildLabelCommitment(label: string): Promise<`0x${string}`> {
  return sha256Hex(label.trim().toLowerCase());
}
