// At-rest encryption for user cloud credentials.
//
// Mirrors the pm project's approach exactly (src/lib/server/google/encrypt.ts):
// HKDF-derive an AES-256-GCM key from the server secret (AUTH_SECRET) with a
// per-purpose `info` label, prefix a random 12-byte IV, and store
// base64(iv || ciphertext+tag). WebCrypto only, so it stays inside the Worker
// CPU budget.
//
// The self-hosting model makes this the right trade: each deployment is one
// person's own Cloudflare account, so the AUTH_SECRET holder and the cloud
// account owner are the same party. Encryption-at-rest keeps the credential out
// of D1 dumps/consoles; it is not (and cannot be) a defense against the operator.

const te = new TextEncoder();
const td = new TextDecoder();

// Domain-separation label — bump the version if the credential format changes.
const CLOUD_INFO = te.encode("amc-cloud-cred-v1");

async function deriveKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: CLOUD_INFO },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a UTF-8 string → base64(iv‖ciphertext+tag). */
export async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(plaintext));
  const combined = new Uint8Array(iv.byteLength + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

/** Decrypt base64(iv‖ciphertext+tag) → the original UTF-8 string. Throws on a
 *  wrong key or tampered ciphertext (AES-GCM auth failure). */
export async function decryptSecret(base64: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const combined = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return td.decode(pt);
}
