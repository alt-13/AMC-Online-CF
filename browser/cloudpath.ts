// The `.amc` path grammar, shared by every cloud connector.
//
// A path is "/"-separated; a trailing ".amc" segment is the filename, everything
// before it the folder chain. Both providers have real folders (Mega nodes,
// Drive folder ids), so a catalog can live at "/Backups/movies.amc" rather than
// only at the account root.

export interface AmcPath {
  /** folder names from the root, in order (empty = the account root) */
  segments: string[];
  /** the ".amc" filename if the path named one, else null */
  filename: string | null;
}

/** Parse a "/Folder/Sub/file.amc"-style path (leading/trailing slashes ok). */
export function splitAmcPath(path: string): AmcPath {
  const parts = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length && parts[parts.length - 1].toLowerCase().endsWith(".amc")) {
    const filename = parts.pop() as string;
    return { segments: parts, filename };
  }
  return { segments: parts, filename: null };
}

/** Is this a `.amc` file name? */
export function isAmcName(name: string): boolean {
  return name.toLowerCase().endsWith(".amc");
}
