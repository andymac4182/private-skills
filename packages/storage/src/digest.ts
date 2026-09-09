import type { Digest } from "../../contracts/src/index.js";

const HEX = "0123456789abcdef";

/**
 * Hash bytes with the Web Crypto SHA-256 primitive. There are no Node-only
 * imports in this module so bundle validation and integrity checks can run in
 * Nitro edge workers as well as Node.
 */
export async function digestBytes(bytes: Uint8Array): Promise<Digest> {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("digestBytes expects a Uint8Array");
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  }
  const input = bytes.slice();
  const hash = await subtle.digest("SHA-256", input);
  const digest = new Uint8Array(hash);
  let hex = "";
  for (const byte of digest) {
    hex += HEX[byte >> 4] + HEX[byte & 0x0f];
  }
  return `sha256:${hex}` as Digest;
}

/** Compare a digest-shaped value without accepting another hash algorithm. */
export function isSha256Digest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
