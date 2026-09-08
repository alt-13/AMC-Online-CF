// The refresh half of oauthpkce: a stored refresh token must renew SILENTLY
// (no popup — the background remote-check pass has no user gesture), and a
// rotated token must be written back, because Microsoft's are single-use.
// The interactive half is a popup and a poll loop, which a unit test cannot
// exercise; what it can prove is that we only fall back to it when the refresh
// grant is gone.

import { describe, it, expect, vi, afterEach } from "vitest";
import { oauthConnect, type PkceOptions } from "./oauthpkce";

const OPTS: PkceOptions = {
  label: "Test",
  authorizeUrl: "https://provider.example/authorize",
  tokenUrl: "https://provider.example/token",
  clientId: "cid",
  scope: "files",
};

interface Call {
  url: string;
  form: URLSearchParams;
}

function fakeFetch(handler: (form: URLSearchParams) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    const form = new URLSearchParams(String(init.body));
    calls.push({ url: String(url), form });
    return Promise.resolve(handler(form));
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Enough of a DOM for the interactive fallback to reach window.open. */
function stubPopupBlocked() {
  vi.stubGlobal("location", { origin: "https://amc.example" });
  vi.stubGlobal("window", { open: () => null });
}

afterEach(() => vi.unstubAllGlobals());

describe("oauthConnect", () => {
  it("renews from a stored refresh token without a popup", async () => {
    const calls = fakeFetch(() => json({ access_token: "at-1" }));
    const creds = { clientId: "cid", refreshToken: "rt-0" };
    const changed = vi.fn();

    const s = await oauthConnect(OPTS, creds, changed);

    expect(s.token).toBe("at-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OPTS.tokenUrl);
    expect(calls[0].form.get("grant_type")).toBe("refresh_token");
    expect(calls[0].form.get("refresh_token")).toBe("rt-0");
    expect(calls[0].form.get("client_id")).toBe("cid");
    expect(calls[0].form.has("client_secret")).toBe(false);
    // Dropbox does not rotate: nothing changed, so nothing is re-encrypted.
    expect(changed).not.toHaveBeenCalled();
    expect(creds.refreshToken).toBe("rt-0");
  });

  it("sends the client secret when the provider needs one (Google)", async () => {
    const calls = fakeFetch(() => json({ access_token: "at" }));
    await oauthConnect({ ...OPTS, clientSecret: "shh" }, { refreshToken: "rt" });
    expect(calls[0].form.get("client_secret")).toBe("shh");
  });

  it("persists a rotated refresh token (Microsoft's are single-use)", async () => {
    fakeFetch((form) => json({ access_token: `at-${form.get("refresh_token")}`, refresh_token: "rt-2" }));
    const creds: Record<string, string> = { refreshToken: "rt-1" };
    const changed = vi.fn();

    const s = await oauthConnect(OPTS, creds, changed);

    expect(s.token).toBe("at-rt-1");
    expect(creds.refreshToken).toBe("rt-2");
    expect(changed).toHaveBeenCalledWith(creds);
    // A later renewal uses the rotated one, not the one it replaced.
    expect(await s.request()).toBe("at-rt-2");
  });

  it("falls back to the interactive flow once the refresh token is refused", async () => {
    const calls = fakeFetch(() => json({ error: "invalid_grant" }, 400));
    stubPopupBlocked();
    const creds = { refreshToken: "dead" };

    await expect(oauthConnect(OPTS, creds, vi.fn())).rejects.toThrow(/popup was blocked/);
    expect(calls).toHaveLength(1); // the refused refresh, then straight to the popup
    // Dropped in memory so the rest of the session does not retry it; the stored
    // blob is left alone, since the failure may have been the network.
    expect(creds.refreshToken).toBe("");
  });

  it("goes interactive when there is no stored refresh token at all", async () => {
    const calls = fakeFetch(() => json({ access_token: "unused" }));
    stubPopupBlocked();
    await expect(oauthConnect(OPTS, {})).rejects.toThrow(/popup was blocked/);
    expect(calls).toHaveLength(0);
  });
});
