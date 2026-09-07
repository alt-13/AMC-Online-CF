import { describe, it, expect } from "vitest";
import type { Storage, File as MegaFile } from "megajs";
import { splitAmcPath } from "./cloudpath";
import {
  folderAt,
  listAmcFiles,
  resolveAmcFile,
  TRANSFER_OPTS,
} from "./mega";

// Minimal fake of the megajs node tree — just the fields the path helpers touch
// (name, directory, children, size, nodeId) plus storage.root and storage.find.
function file(name: string): MegaFile {
  return { name, directory: false, size: 10, nodeId: name } as unknown as MegaFile;
}
function dir(name: string, children: MegaFile[]): MegaFile {
  return { name, directory: true, children } as unknown as MegaFile;
}

function walk(node: MegaFile): MegaFile[] {
  const kids = ((node as unknown as { children?: MegaFile[] }).children ?? []) as MegaFile[];
  return kids.flatMap((c) => [c, ...walk(c)]);
}

function fakeStorage(): Storage {
  const root = dir("", [
    dir("Backups", [
      file("movies.amc"),
      file("notes.txt"),
      dir("old", [file("archive.amc")]),
    ]),
    file("root.amc"),
  ]);
  return {
    root,
    find(pred: (f: MegaFile) => boolean, _deep?: boolean): MegaFile | null {
      return walk(root).find(pred) ?? null;
    },
  } as unknown as Storage;
}

describe("splitAmcPath", () => {
  it("splits a full file path into folder segments + filename", () => {
    expect(splitAmcPath("/Backups/movies.amc")).toEqual({
      segments: ["Backups"],
      filename: "movies.amc",
    });
  });

  it("treats a trailing folder as segments with no filename", () => {
    expect(splitAmcPath("/Backups/old")).toEqual({ segments: ["Backups", "old"], filename: null });
  });

  it("blank/root path is empty segments, no filename", () => {
    expect(splitAmcPath("")).toEqual({ segments: [], filename: null });
    expect(splitAmcPath("/")).toEqual({ segments: [], filename: null });
  });

  it("tolerates stray slashes and whitespace", () => {
    expect(splitAmcPath("  /Backups//movies.amc / ")).toEqual({
      segments: ["Backups"],
      filename: "movies.amc",
    });
  });

  it("detects the .amc extension case-insensitively", () => {
    expect(splitAmcPath("Foo/BAR.AMC").filename).toBe("BAR.AMC");
  });
});

describe("folderAt", () => {
  it("walks existing folders", () => {
    const s = fakeStorage();
    expect(folderAt(s, [])?.name).toBe(""); // root
    expect(folderAt(s, ["Backups"])?.name).toBe("Backups");
    expect(folderAt(s, ["Backups", "old"])?.name).toBe("old");
  });

  it("returns null for a missing folder", () => {
    expect(folderAt(fakeStorage(), ["Nope"])).toBeNull();
    expect(folderAt(fakeStorage(), ["Backups", "ghost"])).toBeNull();
  });

  it("does not treat a file as a folder", () => {
    // "root.amc" is a file at root, not a traversable folder
    expect(folderAt(fakeStorage(), ["root.amc"])).toBeNull();
  });
});

describe("listAmcFiles", () => {
  it("lists .amc files in a folder, skipping non-.amc and subfolders", () => {
    const names = listAmcFiles(fakeStorage(), "/Backups").map((f) => f.name);
    expect(names).toEqual(["movies.amc"]);
  });

  it("lists at root", () => {
    expect(listAmcFiles(fakeStorage(), "").map((f) => f.name)).toEqual(["root.amc"]);
  });

  it("recurses subfolders when deep", () => {
    const names = listAmcFiles(fakeStorage(), "/Backups", true)
      .map((f) => f.name)
      .sort();
    expect(names).toEqual(["archive.amc", "movies.amc"]);
  });

  it("returns [] for a missing folder", () => {
    expect(listAmcFiles(fakeStorage(), "/Nope")).toEqual([]);
  });
});

describe("resolveAmcFile", () => {
  it("resolves a file at its exact path", () => {
    expect(resolveAmcFile(fakeStorage(), "/Backups/movies.amc")?.name).toBe("movies.amc");
  });

  it("falls back to a deep search when the folder path is wrong", () => {
    // archive.amc really lives in /Backups/old; ask for it at the root
    expect(resolveAmcFile(fakeStorage(), "/archive.amc")?.name).toBe("archive.amc");
  });

  it("returns null when the filename exists nowhere", () => {
    expect(resolveAmcFile(fakeStorage(), "/ghost.amc")).toBeNull();
  });

  it("returns null for a folder-only path (no filename)", () => {
    expect(resolveAmcFile(fakeStorage(), "/Backups")).toBeNull();
  });
});

// Regression guard: an `initialChunkSize` here moves the upload POST offsets off
// MEGA's canonical chunk boundaries and the API answers "Server returned error
// -7" (ERANGE) for any file over 1 MB. Connection count is the only knob.
describe("TRANSFER_OPTS", () => {
  it("does not override megajs's chunk sizing", () => {
    expect(Object.keys(TRANSFER_OPTS)).toEqual(["maxConnections"]);
  });
});
