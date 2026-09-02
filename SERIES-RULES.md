# Series rules — follow-up plan

## Why this exists

The catalog bar can show a `N films / N series` tally. **There is no series flag
in the `.amc` format.** `movies.number` is just the on-disk catalog number;
whether a given entry is "a series" is a convention each user invented for their
own catalog. Known conventions in the wild:

| Convention | Example |
|---|---|
| All series parked under one number so they sort together | every series has `number = 1` |
| Each series gets its own number, shared by its episodes | `number = 12` on all 6 episodes |
| A certification string marks it | `certification = "TV Series"` / `"TV Mini-Series"` |
| A custom field marks it | `custom_values.SERIES = "1"`, or a `Type` field = `TV` |
| A category / media-type string | `category` contains `Series`, `media_type = "TV"` |
| Nothing — the user has no series | counts are noise |

Guessing produces a confidently wrong number, which is worse than no number. So
the shipped default is **off**, and the user states the rule.

## What ships today

`SeriesRule` in [`frontend/fields.ts`](frontend/fields.ts), persisted in the
`user_settings` JSON blob as `series_rule` (no migration — the Worker's
`DEFAULT_SETTINGS` spread backfills the key for existing users).

```ts
type SeriesRule =
  | { kind: "off" }                                 // default: bar shows no counts
  | { kind: "certification_in"; values: string[] }   // certification is one of these
  | { kind: "number_is"; number: number }            // every entry with this number is a series
  | { kind: "number_shared" }                        // a number used by 2+ entries is ONE series
```

`countSeries(movies, rule)` returns `{ films, series }` or `null` (= show
nothing). Configured under **Settings → Series count**. Covered by
`frontend/series-count.test.ts`.

`certification_in` seeds with `["TV Series", "TV Mini-Series"]` and the list is
edited as chips, because certification is free text in the format — there is no
vocabulary to offer, and different catalogs spell the same idea differently.
Matching is **whole-value, trimmed, case-insensitive**: substring matching would
make `TV Series` swallow `Not a TV Series`, and casefolding is what makes a
hand-typed catalog usable at all. An empty list matches **nothing**, so a
half-configured rule reads "0 series" rather than "every film is a series".

One deliberate limit remains: the rule is **per user, not per catalog**.

## Follow-up

### 1. Generalise the value match to any field

`certification_in` is the concrete case that shipped. Every further "which field
marks a series" request (a custom field, `category`, `media_type`) wants the same
predicate against a different column, and adding a bespoke `kind` per field does
not scale. Subsume it:

```ts
| { kind: "field"; field: string; op: "eq" | "contains" | "truthy"; value?: string }
```

`field` reuses the existing `custom_<tag>` key convention already shared by
`settings.search_field` and the search-scope picker, so `custom_SERIES` and
plain columns (`category`, `media_type`) address uniformly, and
`frontend/fields.ts` `parseCustom` already resolves the custom side.
`certification_in` then becomes sugar for
`{ kind: "field", field: "certification", op: "in", values }` — keep the old
kind readable in `countSeries` so stored settings keep working, or migrate it in
the same `DEFAULT_SETTINGS` spread that backfills new keys.

The settings UI becomes: a field picker (reuse `searchScopes(defs)` — it already
groups columns and custom fields), an operator select, and a value box. Worth
showing a live "matches N of M entries" preview so a user can tell immediately
whether the rule caught the right rows; that is the main thing that makes a rule
builder usable rather than a guessing game.

### 2. Per-catalog rules

Conventions differ *between* catalogs, not just between users — one library
imported from someone else will not follow your numbering. Move the rule to
`catalogs` (a `series_rule` TEXT column holding the same JSON, needs a
migration), falling back to the user-level rule when unset. Do this only after
(1) — a per-catalog knob that only offers number rules is not worth the
migration.

### 3. Counting mode

`number_shared` currently reports **distinct series**; `number_is` and
`certification_in` report **entries**. That is right for each convention as written, but if a user wants
"how many episodes do I have", add an explicit
`countMode: "series" | "entries"` rather than overloading the rule kind. Only
worth it if someone actually asks.

### 4. Surface the rule where it acts

The bar shows bare numbers with no indication of what defined them. A tooltip on
the counts spelling out the active rule ("series = entries numbered 1") would
make a misconfigured rule self-diagnosing instead of quietly wrong.

### Not planned

Auto-detecting the convention. Every heuristic (a number with suspiciously many
entries, a mostly-empty custom field) is wrong often enough to be untrustworthy,
and a wrong count that appears without being asked for is exactly the failure
this design set out to avoid.
