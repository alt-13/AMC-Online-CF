// OAuth for every REST connector: authorization code + PKCE in a popup, plus
// the silent refresh that keeps a reconnect from needing one.
//
// Shared by Drive, OneDrive and Dropbox. Each is a couple hundred KB of vendor
// SDK away from a string this file produces in ~100 lines: a random verifier,
// its SHA-256 challenge, a popup to /authorize, one form POST to /token, and a
// refresh_token grant for every token after that.
//
// `oauthConnect` is what a connector calls. It hands back a session whose
// `request()` refreshes SILENTLY when a refresh token is held and only falls
// back to the popup when there is none (or the provider rejected it) — which is
// what makes the background remote-check pass work without a user gesture. The
// refresh token is written back into the credential blob (encrypted at rest in
// user_cloud) through `onCredentials`; that write-back is not optional, because
// Microsoft rotates the token on every use and invalidates the one it replaces.

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomB64 = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** The deploy's own origin, which is what must be registered as the redirect
 *  URI (see README, "Connecting OneDrive" / "Connecting Dropbox"). */
export const redirectUri = () => `${location.origin}/`;

/**
 * Wait for the popup to come back to our origin carrying a `code`.
 *
 * Polling rather than postMessage, so no callback page has to exist: the popup
 * lands on our own index.html, which we can read once it is same-origin again
 * (the read throws while it is still on the provider's domain). Reads both the
 * query and the fragment, since providers differ on where they put the code.
 */
function awaitCode(popup: Window, state: string, label: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stop = () => {
      clearInterval(poll);
      clearTimeout(timeout);
    };
    const fail = (msg: string) => {
      stop();
      popup.close();
      reject(new Error(msg));
    };
    const poll = setInterval(() => {
      let params: URLSearchParams;
      try {
        if (popup.closed) return fail(`${label} sign-in was cancelled`);
        if (popup.location.origin !== location.origin) return; // still at the provider
        const { hash, search } = popup.location;
        params = new URLSearchParams(hash.slice(1) || search.slice(1));
      } catch {
        return; // cross-origin document — not back yet
      }
      const code = params.get("code");
      const error = params.get("error");
      if (!code && !error) return;
      // The state check is the CSRF guard: a code we did not ask for is refused.
      if (params.get("state") !== state) return fail(`${label} sign-in state mismatch`);
      if (!code) return fail(params.get("error_description") || error || `${label} sign-in failed`);
      stop();
      popup.close();
      resolve(code);
    }, 250);
    const timeout = setTimeout(() => fail(`${label} sign-in timed out`), 5 * 60_000);
  });
}

export interface PkceOptions {
  /** Provider name as it appears in error text, e.g. "Microsoft". */
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
  /** Only Google needs one: its token endpoint refuses a Web-application client
   *  without it, whatever PKCE says. It is the operator's own secret, stored
   *  encrypted in user_cloud like any other credential. */
  clientSecret?: string;
  /** Provider extras for /authorize (response_mode, access_type, …). */
  authParams?: Record<string, string>;
}

interface TokenSet {
  access: string;
  /** "" when the provider issued none (no offline scope, or a refresh grant
   *  that did not rotate the token). */
  refresh: string;
}

/** One POST to /token, whatever the grant. */
async function tokenRequest(o: PkceOptions, grant: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(o.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: o.clientId,
      ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
      ...grant,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(
      body.error_description || body.error || `${o.label} sign-in failed (${res.status})`,
    );
  }
  return { access: body.access_token, refresh: body.refresh_token ?? "" };
}

/** The interactive half: popup → code → tokens. */
async function pkceToken(o: PkceOptions): Promise<TokenSet> {
  const verifier = randomB64(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const state = randomB64(16);
  const authUrl =
    `${o.authorizeUrl}?` +
    new URLSearchParams({
      client_id: o.clientId,
      response_type: "code",
      redirect_uri: redirectUri(),
      scope: o.scope,
      state,
      code_challenge: b64url(new Uint8Array(digest)),
      code_challenge_method: "S256",
      ...o.authParams,
    });

  const popup = window.open(authUrl, "cloud-signin", "width=520,height=680");
  if (!popup) throw new Error(`the ${o.label} sign-in popup was blocked — allow popups and retry`);
  const code = await awaitCode(popup, state, o.label);

  return tokenRequest(o, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
}

/** A live provider session. `token` is the current access token; `request()`
 *  mints a fresh one (silently where possible) and stores it here too. */
export interface OAuthSession {
  token: string;
  request(): Promise<string>;
}

/**
 * Open a session from a credential blob, keeping its `refreshToken` current.
 *
 * The blob is mutated in place AND reported through `onCredentials`, because a
 * rotation can happen at any point in a long push, not only at login — and a
 * rotation that is not persisted logs the user out of the background pass.
 * `onCredentials` is omitted when the user did not tick "keep me signed in",
 * which makes the whole thing session-only.
 */
export async function oauthConnect(
  o: PkceOptions,
  creds: Record<string, string>,
  onCredentials?: (c: Record<string, string>) => void,
): Promise<OAuthSession> {
  const keep = (t: TokenSet) => {
    if (t.refresh && t.refresh !== creds.refreshToken) {
      creds.refreshToken = t.refresh;
      onCredentials?.(creds);
    }
    return t.access;
  };
  const s: OAuthSession = {
    token: "",
    async request() {
      if (creds.refreshToken) {
        try {
          return (s.token = keep(
            await tokenRequest(o, {
              grant_type: "refresh_token",
              refresh_token: creds.refreshToken,
            }),
          ));
        } catch {
          // Revoked, expired, or offline. Drop it and ask the user — in the
          // background there is no gesture, so this throws and cloud.ts keeps
          // the cached verdict (SYNC.md).
          creds.refreshToken = "";
        }
      }
      return (s.token = keep(await pkceToken(o)));
    },
  };
  await s.request();
  return s;
}
