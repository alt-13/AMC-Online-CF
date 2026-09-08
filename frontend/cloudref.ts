// Pure helpers for cloud origin keys (catalogs.source_ref) and provider choice.
// No provider SDK / DOM imports, so this is trivially unit-testable.

/** A catalog's source_ref is "<provider>:<provider-specific locator>". Split on
 *  the FIRST colon only — the locator keeps any colons of its own. */
export function parseSourceRef(ref: string): { provider: string; locator: string } {
  const i = ref.indexOf(":");
  if (i < 0) return { provider: ref, locator: "" };
  return { provider: ref.slice(0, i), locator: ref.slice(i + 1) };
}

/**
 * Every connector locates a file as "<folder handle>:<filename>" — Mega by
 * node handle, Drive and OneDrive by folder id, Dropbox by parent path ("" at
 * the root, so an empty handle is legal). Resolving by NAME inside a stable
 * folder is what survives the delete-and-recreate that the providers' overwrite
 * paths (and users) do to a file, so none of them stores the file's own id.
 *
 * Split on the first colon so the filename may contain spaces/parens/colons.
 */
export function splitLocator(locator: string): { handle: string; name: string } {
  const i = locator.indexOf(":");
  if (i < 0) return { handle: locator, name: "" };
  return { handle: locator.slice(0, i), name: locator.slice(i + 1) };
}

export function formatSourceRef(provider: string, folderHandle: string, name: string): string {
  return `${provider}:${folderHandle}:${name}`;
}

/** The provider whose row to show/active first: the newest credentialed one,
 *  else "mega". Mirrors the server's `updatedAt` (epoch ms). */
export function pickActiveProvider(
  rows: Array<{ provider: string; hasCredential: boolean; updatedAt: number }>,
): string {
  const credentialed = rows.filter((r) => r.hasCredential);
  if (!credentialed.length) return "mega";
  return credentialed.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).provider;
}
