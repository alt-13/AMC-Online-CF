// A READ-ONLY summary of how the local rows differ from a parsed remote .amc.
//
// WHY A HEURISTIC KEY IS OK HERE, AND ONLY HERE.
//
// The .amc format has no movie id, and `number` is non-unique and user-editable
// (rule 12), so `number + title` cannot be a merge key: it changes under exactly
// the edits people make (renames, renumbers), and a wrong match would silently
// merge the wrong movie's data. The write path therefore replaces rows
// wholesale and never uses this.
//
// But populating a dialog is different: nothing is written, so being approximate
// costs nothing, and it turns "choose which side to discard, and hope" into an
// informed choice. That is the entire purpose of this module.
//
// Pure: no DOM, no megajs, no fetch.

import type { MovieRow } from "./api";
import type { AMCMovie } from "../amc/types";

export interface DiffSummary {
  onlyRemote: number;
  onlyLocal: number;
  differing: number;
  /** Up to 5 sample titles per bucket, for the dialog. */
  samples: { onlyRemote: string[]; onlyLocal: string[]; differing: string[] };
}

const SAMPLE_CAP = 5;

/** Display title: translated wins, matching how sort_title is derived
 *  (`lower(coalesce(translated, original))`, worker/index.ts). */
function localTitle(m: MovieRow): string {
  return m.translated_title || m.original_title || "";
}
function remoteTitle(m: AMCMovie): string {
  return m.translatedTitle || m.originalTitle || "";
}

/** The heuristic match key. Never used to write. */
function key(number: number, title: string): string {
  return `${number}\u001f${title.toLowerCase().trim()}`;
}

/** The fields worth comparing for "differing". Deliberately the ones a person
 *  would notice, not every column — this is a summary, not a merge. */
function localShape(m: MovieRow): string {
  return [
    m.original_title, m.translated_title, m.year, m.director, m.rating,
    m.category, m.length, m.description,
  ].join("\u001f");
}
function remoteShape(m: AMCMovie): string {
  return [
    m.originalTitle, m.translatedTitle, m.year, m.director, m.rating,
    m.category, m.length, m.description,
  ].join("\u001f");
}

/**
 * Compare local rows against a parsed remote catalog's movies.
 *
 * Duplicate keys are handled by consuming matches from a pool: with three local
 * and one remote entry sharing a key, one pair matches and the surplus two count
 * as local-only. No one-to-one mapping is claimed, which is the conservative
 * reading — it never under-reports what the user is about to lose.
 */
export function summarizeDiff(local: MovieRow[], remote: AMCMovie[]): DiffSummary {
  const remotePool = new Map<string, AMCMovie[]>();
  for (const m of remote) {
    const k = key(m.number, remoteTitle(m));
    const list = remotePool.get(k) ?? [];
    list.push(m);
    remotePool.set(k, list);
  }

  const out: DiffSummary = {
    onlyRemote: 0, onlyLocal: 0, differing: 0,
    samples: { onlyRemote: [], onlyLocal: [], differing: [] },
  };
  const push = (bucket: keyof DiffSummary["samples"], title: string) => {
    if (out.samples[bucket].length < SAMPLE_CAP) out.samples[bucket].push(title || "(untitled)");
  };

  for (const l of local) {
    const k = key(l.number, localTitle(l));
    const candidates = remotePool.get(k);
    const match = candidates?.shift();
    if (!match) {
      out.onlyLocal += 1;
      push("onlyLocal", localTitle(l));
      continue;
    }
    if (candidates && !candidates.length) remotePool.delete(k);
    if (localShape(l) !== remoteShape(match)) {
      out.differing += 1;
      push("differing", localTitle(l));
    }
  }

  // Whatever is left in the pool exists only on the remote side.
  for (const leftovers of remotePool.values()) {
    for (const r of leftovers) {
      out.onlyRemote += 1;
      push("onlyRemote", remoteTitle(r));
    }
  }

  return out;
}
