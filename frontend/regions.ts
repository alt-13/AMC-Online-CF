// Streaming region picker data. The full ISO 3166-1 alpha-2 list is hardcoded
// (there is no Intl API that enumerates regions); names come from the browser
// via Intl.DisplayNames, flags from regional-indicator emoji. Windows has no
// flag glyphs — main.ts loads country-flag-emoji-polyfill for that.

import type { AppSettings } from "./fields";

export const REGION_CODES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL " +
  "BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV " +
  "CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD " +
  "GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM " +
  "IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK " +
  "LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW " +
  "MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR " +
  "PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS " +
  "ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY " +
  "UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

/** "AT" -> 🇦🇹 (regional indicator A = U+1F1E6). */
export function flagOf(code: string): string {
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** The locale's region ("de-AT" -> "AT"), else US (TMDB's own default). */
export function defaultRegion(locale: string = navigator.language): string {
  const r = /[-_]([A-Za-z]{2})(?:$|[-_])/.exec(locale)?.[1]?.toUpperCase();
  return r && REGION_CODES.includes(r) ? r : "US";
}

/** The region streaming lookups use: the saved one, or the browser's. */
export function regionFor(s: Pick<AppSettings, "streaming_region">, locale?: string): string {
  return s.streaming_region || defaultRegion(locale);
}

export interface RegionOption { value: string; name: string; label: string }

/** Dropdown options, "🇦🇹 Austria (AT)", sorted by the country's name. */
export function regionOptions(locale: string = navigator.language): RegionOption[] {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  return REGION_CODES.map((c) => {
    const name = names.of(c) ?? c;
    return { value: c, name, label: `${flagOf(c)} ${name} (${c})` };
  }).sort((a, b) => a.name.localeCompare(b.name, locale));
}
