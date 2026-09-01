// The selected row's highlight is a CASCADE question, not a logic one.
//
// MovieListView paints row hover/selection by hand (selection is manual — see
// `rowClass` — so the unsaved-changes guard keeps control of what gets selected).
// Those manual rules live in the same scoped stylesheet as the
// `.p-datatable-tbody > tr { background: transparent }` reset that flattens
// PrimeVue's own row background. A bare `.amc-row-sel` ties that reset on class
// count and loses on its extra type selector, so `transparent` won and a
// selected row rendered unhighlighted — invisible to every unit test we had.
//
// This locks the ordering in: whatever shape the rules take, the selection
// background must out-rank the reset.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse, compileStyle } from "vue/compiler-sfc";

/** CSS specificity as [ids, classes, types]; :not()/:is() contribute their most
 *  specific argument (per selectors-4), pseudo-elements are ignored. */
function specificity(selector: string): [number, number, number] {
  let s = selector;
  let ids = 0;
  let classes = 0;
  let types = 0;

  // Functional pseudo-classes: recurse, take the max argument, then strip.
  s = s.replace(/:(?:not|is|has)\(([^()]*)\)/g, (_m, inner: string) => {
    const best = inner
      .split(",")
      .map((part) => specificity(part.trim()))
      .reduce((a, b) => (compare(a, b) >= 0 ? a : b), [0, 0, 0] as [number, number, number]);
    ids += best[0];
    classes += best[1];
    types += best[2];
    return " ";
  });

  s = s.replace(/::[\w-]+/g, " "); // pseudo-elements: no contribution
  ids += (s.match(/#[\w-]+/g) ?? []).length;
  classes += (s.match(/\.[\w-]+/g) ?? []).length; // classes
  classes += (s.match(/\[[^\]]+\]/g) ?? []).length; // attribute selectors (incl. data-v-*)
  classes += (s.match(/:[\w-]+(?:\([^()]*\))?/g) ?? []).length; // pseudo-classes
  s = s.replace(/[.#][\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^()]*\))?/g, " ");
  types += (s.match(/(?:^|[\s>+~])([a-zA-Z][\w-]*)/g) ?? []).length;

  return [ids, classes, types];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The component's scoped <style> as the browser finally sees it. */
function compiledStyle(): string {
  const file = new URL("./MovieListView.vue", import.meta.url);
  const { descriptor } = parse(readFileSync(file, "utf8"), { filename: "MovieListView.vue" });
  const block = descriptor.styles.find((b) => b.scoped);
  expect(block, "MovieListView must keep a scoped <style> block").toBeTruthy();
  return compileStyle({
    source: block!.content,
    filename: "MovieListView.vue",
    id: "data-v-test",
    scoped: true,
  }).code;
}

/** Every `background:` rule in the compiled sheet, in source order. */
function backgroundRules(css: string): Array<{ selector: string; value: string }> {
  const out: Array<{ selector: string; value: string }> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decl = /(?:^|[;\s])background\s*:\s*([^;}]+)/.exec(m[2]);
    if (decl) out.push({ selector: m[1].trim().replace(/\s+/g, " "), value: decl[1].trim() });
  }
  return out;
}

describe("MovieListView row-selection highlight", () => {
  const rules = backgroundRules(compiledStyle());
  const reset = rules.find((r) => /tr$/.test(r.selector) && /transparent|^0 0$/.test(r.value));
  const selected = rules.find((r) => r.selector.includes(".amc-row-sel") && !r.selector.includes(":hover"));

  it("has both the row-background reset and a selected-row rule", () => {
    expect(reset, "expected a `.p-datatable-tbody > tr` background reset").toBeTruthy();
    expect(selected, "expected a `.amc-row-sel` background rule").toBeTruthy();
  });

  it("paints the selected row: its rule out-ranks the reset", () => {
    const sSel = specificity(selected!.selector);
    const sReset = specificity(reset!.selector);
    const order = compare(sSel, sReset);
    // Equal specificity is fine ONLY if the selection rule comes later.
    const wins = order > 0 || (order === 0 && rules.indexOf(selected!) > rules.indexOf(reset!));
    expect(
      wins,
      `selected-row rule loses the cascade to the reset\n` +
        `  selected: ${selected!.selector}  → ${sSel.join(",")}\n` +
        `  reset:    ${reset!.selector}  → ${sReset.join(",")}`,
    ).toBe(true);
  });

  it("keeps the hover rule from covering the selection", () => {
    const hover = rules.find((r) => r.selector.includes(":hover"));
    expect(hover, "expected a hover background rule").toBeTruthy();
    // Hovering the selected row must not repaint it as a plain hover.
    expect(hover!.selector).toContain(":not(.amc-row-sel)");
  });
});
