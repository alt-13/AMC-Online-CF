// Worker-native auth — the CF replacement for backend/app/auth.py.
//
// WHY NOT bcrypt: the Python app hashes with bcrypt (12 rounds ≈ tens of ms of
// pure JS CPU). That alone blows the Workers Free-plan 10ms CPU/request budget.
// Cloudflare's own recommended fix (and what the pm project ships) is WebCrypto:
// PBKDF2-SHA256 runs in native code, and HMAC for JWTs is microseconds. So the
// login path stays under budget without dropping to an insecure round count.
//
// WHY NOT CF Access: Cloudflare Access (Zero Trust) is a real auth mechanism,
// but it gates an app behind an org + identity provider you administer — great
// for a private/single-operator deploy, wrong for the stated goal of a generic
// app strangers can sign up to. Access is noted as an option in CF-PORT.md; this
// module implements the self-serve path.
//
// Token shape mirrors auth.py exactly ({sub, type, exp}, HS256) so the existing
// frontend composables/useAuth.ts works unchanged: access token in the response
// body, refresh token in an httpOnly cookie.

// --- base64url -------------------------------------------------------------

const te = new TextEncoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const b64urlFromString = (s: string): string => b64urlFromBytes(te.encode(s));

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

// --- password hashing (PBKDF2-SHA256, WebCrypto) ---------------------------

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCHEME = "pbkdf2-sha256";

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    te.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** `pbkdf2-sha256$<iterations>$<salt-b64>$<key-b64>` (self-describing). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(password, salt, ITERATIONS);
  return `${SCHEME}$${ITERATIONS}$${btoa(String.fromCharCode(...salt))}$${btoa(String.fromCharCode(...key))}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parts = hash.split("$");
  if (parts.length !== 4 || parts[0] !== SCHEME) return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const dec = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const salt = dec(parts[2]);
  const expected = dec(parts[3]);
  const actual = await deriveKey(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

// --- JWT (HS256 via WebCrypto HMAC) ----------------------------------------

export interface JwtPayload {
  sub: string; // user id == tenant id
  type: "access" | "refresh";
  exp: number; // seconds since epoch
  iat: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(secret: string, sub: string, type: "access" | "refresh", ttlSec: number, nowSec: number): Promise<string> {
  const header = b64urlFromString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlFromString(JSON.stringify({ sub, type, iat: nowSec, exp: nowSec + ttlSec }));
  const data = `${header}.${payload}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(data)));
  return `${data}.${b64urlFromBytes(sig)}`;
}

/** Verify signature, expiry and type. Returns the payload or null. */
export async function verifyJwt(
  secret: string,
  token: string,
  expectedType: "access" | "refresh",
  nowSec: number,
): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, bytesFromB64url(s), te.encode(`${h}.${p}`));
  if (!ok) return null;
  let payload: JwtPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(p)));
  } catch {
    return null;
  }
  if (payload.type !== expectedType) return null;
  if (typeof payload.exp !== "number" || payload.exp < nowSec) return null;
  return payload;
}

const ACCESS_TTL_SEC = 60 * 60; // 1h — matches auth.py default
const REFRESH_TTL_SEC = 7 * 24 * 60 * 60; // 7d

export function createAccessToken(secret: string, userId: string, nowSec: number): Promise<string> {
  return sign(secret, userId, "access", ACCESS_TTL_SEC, nowSec);
}
export function createRefreshToken(secret: string, userId: string, nowSec: number): Promise<string> {
  return sign(secret, userId, "refresh", REFRESH_TTL_SEC, nowSec);
}

// --- refresh cookie helpers ------------------------------------------------

const REFRESH_COOKIE = "amc_refresh";

export function refreshCookie(token: string): string {
  return `${REFRESH_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=${REFRESH_TTL_SEC}`;
}
export function clearRefreshCookie(): string {
  return `${REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0`;
}
export function readRefreshCookie(req: Request): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === REFRESH_COOKIE) return part.slice(eq + 1);
  }
  return null;
}

/**
 * Resolve the caller's user id (== tenant) from the Bearer access token.
 * Returns null when absent/invalid — the caller turns that into a 401.
 */
export async function authenticate(secret: string, req: Request, nowSec: number): Promise<string | null> {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return null;
  const payload = await verifyJwt(secret, h.slice(7), "access", nowSec);
  return payload?.sub ?? null;
}
