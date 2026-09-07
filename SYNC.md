# Cloud sync — revisions, status, conflicts

How a catalog in D1 is kept in step with the `.amc` file it came from in the
cloud. Read [`CF-PORT.md`](CF-PORT.md) first for the data flow this sits on.

Cloud transfers run **only in the browser** (megajs crypto can't live in a
Worker, the Worker never holds a whole `.amc`, and Drive's REST API sends
permissive CORS so no proxy is needed). The Worker only stores the bookkeeping
the browser reports.

Every provider sits behind **one interface**, `CloudConnector` in
`frontend/connector.ts` (`connector-mega.ts`, `connector-drive.ts`).
`frontend/cloud.ts` owns the workflow and is provider-free: sessions, file nodes
and fingerprints are opaque values it hands straight back to the connector.
Adding a backend is one `connector-*.ts` plus one line in `CONNECTORS`.

## The reference: `catalogs.source_ref`

`"<provider>:<provider-specific locator>"`. Both connectors use
`"<folder handle>:<filename>"` (Mega node handle / Drive folder id) — resolving
by NAME inside a stable folder is what survives the delete-and-recreate that
overwrites and users do to a file, so the file's own id is never stored. Split on
the **first** colon only — locators and filenames keep colons of their own. Pure
helpers in `frontend/cloudref.ts`.
A direct-upload catalog has no `source_ref` (status `local-only`) until
`POST /api/catalog/:id/source-ref` adopts one on its first push.

## The revision counter (migration 0003)

`catalogs.content_rev` is bumped by **every** movie mutation
(`db.bumpCatalogRev`); `synced_rev` is the value that was pushed. `content_rev -
synced_rev` is the exact number of pending revisions — a counter, not a
timestamp, so no clock skew between Worker, browser and provider.

Remote half: `content_hash` (of the pushed bytes), `remote_fingerprint`,
`remote_size`, `remote_state`, `remote_checked_at`, `last_sync_at`.
`movies.updated_at` powers "M movies touched since the last sync"
(`touched_since_sync` on `/api/catalog/:id/info`).

Pre-0003 rows land on `0/0` with `remote_checked_at = NULL`, which derives as
**unknown** — honest, because no fingerprint is held for them.

## Status derivation — pure, one function

`deriveStatus(catalog, inFlight?)` in `frontend/syncstatus.ts` is the only place
status is computed; the catalogs-list chip and the workspace sync button both
read it. Kinds: `local-only`, `syncing`, `unknown`, `remote-gone`, `synced`,
`not-synced`, `changed-externally`, `conflict`.

**The guiding asymmetry: a false "changed externally" is safe (it prompts a
re-import, which is idempotent); a false "synced" loses data.** Every ambiguity
must resolve away from `synced`. Order of the checks in `deriveStatus` is load-
bearing — each assumes the ones above did not fire.

## Never merge rows by `number + title`

The `.amc` format has no movie id and `number` is non-unique and user-editable
(CLAUDE.md rule 12), so there is no merge key. **Write paths replace a
catalog's rows wholesale** (`POST /api/catalog/:id/reimport-begin`, then a normal
import) and never match rows heuristically.

The one exception is `frontend/syncdiff.ts`, which builds the conflict dialog's
read-only summary (`onlyLocal` / `onlyRemote` / `differing` + sample titles).
Nothing is written from it, so approximate is fine there — and only there. Its
`differing` comparison relies on both sides sharing the same "unset" convention
(`NOT NULL DEFAULT -1 / ''` in `schema.sql`, `-1` in `amc/types.ts`); a
migration making one of those eight columns nullable would produce spurious
counts.

## Fingerprints and the transfer itself

A fingerprint is **opaque**, and only the connector's `sameContent(a, b)`
compares two. Mega's packs a content CRC next to an mtime, so a byte comparison
would call a mtime-only touch a change; Drive's is a plain `md5Checksum`. An
empty fingerprint is never a match — the safe direction. A push RETURNS the
resulting fingerprint, because only the connector knows what the provider
stored.

Mega: `browser/mega-fingerprint.ts` computes the fingerprint client-side and
`browser/mega.ts` injects it as `attributes.c` — MEGAsync rejects files without
it. Chunk offsets must stay on MEGA chunk boundaries (no `initialChunkSize`
override).

Drive: a chunked **resumable** upload (8 MiB, a 256 KiB multiple as Google
requires), because `fetch` cannot report progress on a single request body and a
silent multi-hundred-megabyte upload is exactly what the UI must not do. A 308
reply carries the range Drive actually committed, which may be less than was
sent, so the next offset comes from that header. A push overwrites the existing
file **by id**, so its Drive id, share links and comments survive.

Downloaded `.amc` blobs are cached in Cache Storage (`frontend/amccache.ts`,
pruned on boot); `frontend/cloud.ts` bridges provider ↔ import/export and holds
the per-user cloud config + remember-me.

## Sync API

| Method & path | Purpose |
|---|---|
| `POST /api/catalog/:id/source-ref` | adopt a cloud origin for a catalog that had none |
| `POST /api/catalog/:id/sync-state` | record a push outcome: `synced_rev`, `content_hash`, fingerprint, size (browser reports; `remote_state = 'match'` is known, not guessed) |
| `POST /api/catalogs/remote-state` | record a remote-check pass (fingerprint/size/state) with no download |
| `POST /api/catalog/:id/reimport-begin?cursor=` | replace a catalog's contents in place: drop rows/defs, then page an R2 sweep (catalog row survives) |
| `POST /api/catalog/:id/supersede` | after a cloud re-pull, drop older catalogs sharing this `source_ref` |
| `POST /api/catalog/:id/gc-posters?cursor=` | reclaim unreferenced poster blobs, one R2 list page per request |

Every paging route returns `next` and the browser loops it (`browser/sweep.ts`
`sweepAll`) — a Worker has ~10 ms of CPU, so no unbounded sweep may live server
side.
