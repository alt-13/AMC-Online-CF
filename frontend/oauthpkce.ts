// One interactive OAuth sign-in: authorization code + PKCE, in a popup.
//
// Shared by the connectors whose provider mandates PKCE for a browser app and
// issues no client secret (OneDrive, Dropbox). Each is a couple hundred KB of
// vendor SDK away from a string this file produces in ~60 lines: a random
// verifier, its SHA-256 challenge, a popup to /authorize, one form POST to
// /token. Google is NOT here — GIS hands out tokens through its own script.
//
// Because there is no secret, nothing about these providers needs a Worker
// secret, a route or a deploy step; the public client id the operator pastes is
// all that gets stored, and the grant itself lives in the user's provider
// session.

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
  /** Provider extras for /authorize (response_mode, login_hint, …). */
  authParams?: Record<string, string>;
}

/** Run the whole flow and return an access token. */
export async function pkceToken(o: PkceOptions): Promise<string> {
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

  const res = await fetch(o.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: o.clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(
      body.error_description || body.error || `${o.label} sign-in failed (${res.status})`,
    );
  }
  return body.access_token;
}
