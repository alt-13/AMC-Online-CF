import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./crypto";

describe("cloud credential encryption", () => {
  const secret = "test-auth-secret";
  const plain = JSON.stringify({ email: "a@b.co", password: "hunter2" });

  it("round-trips a credential", async () => {
    const enc = await encryptSecret(plain, secret);
    expect(await decryptSecret(enc, secret)).toBe(plain);
  });

  it("does not leak the plaintext into the ciphertext", async () => {
    const enc = await encryptSecret(plain, secret);
    expect(enc).not.toContain("hunter2");
  });

  it("uses a random IV, so equal inputs give distinct ciphertexts", async () => {
    const a = await encryptSecret("x", secret);
    const b = await encryptSecret("x", secret);
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong secret (GCM auth)", async () => {
    const enc = await encryptSecret(plain, secret);
    await expect(decryptSecret(enc, "wrong-secret")).rejects.toBeTruthy();
  });
});
