<!--
  RatingsBar.vue — the movie header's rating chips + streaming icons. Rendered
  as a fragment inside MovieDetail's header row, so it flows with the user-rating
  and watched pills. The selected source (Settings → Rating source) is the gold
  lead chip showing the STORED Rating field; the others show their own site's
  value and format. Mobile keeps only the lead chip.
-->
<template>
  <template v-for="s in chips" :key="s.key">
    <div
      v-if="s.key === source"
      class="flex items-center gap-1 bg-gold-dim text-gold px-[0.55rem] py-[0.2rem] rounded-xl text-[0.82rem] font-semibold
             max-md:gap-0.5 max-md:px-1.5 max-md:py-0 max-md:text-[0.72rem]"
      :class="{ 'opacity-50': rating <= 0 }"
      v-tooltip.top="leadTip"
      :aria-label="`${s.name} ${storedFormat(rating)}`"
    >
      <i class="pi pi-star-fill text-[0.7rem] max-md:text-[0.6rem]" />
      {{ storedFormat(rating) }}
      <span class="font-light text-[0.7rem] max-md:hidden">{{ s.short }}</span>
      <i v-if="drift !== null" class="pi pi-pencil text-[0.6rem]" />
    </div>
    <span
      v-else
      class="text-[0.78rem] font-semibold tabular-nums"
      :class="[TONE_CLASS[toneOf(s.key, val(s.key))], { 'opacity-50': val(s.key) === null }]"
      v-tooltip.top="`${s.name} ${nativeFormat(s.key, val(s.key))}`"
    >
      <span class="font-light text-muted">{{ s.short }}</span>
      {{ nativeFormat(s.key, val(s.key)) }}
    </span>
  </template>

  <a
    v-for="p in providers"
    :key="p.id"
    :href="watchLink"
    target="_blank"
    rel="noopener"
    class="inline-flex shrink-0 rounded-md overflow-hidden border border-border hover:border-gold transition-colors"
    v-tooltip.top="`${p.name} · ${KIND_LABEL[p.kind]}`"
    :aria-label="`Watch on ${p.name} (${KIND_LABEL[p.kind]})`"
  >
    <img v-if="p.logo" :src="p.logo" alt="" class="block w-6 h-6 max-md:w-5 max-md:h-5" loading="lazy" />
    <span v-else class="px-1 text-[0.65rem] leading-6">{{ p.name }}</span>
  </a>
  <span v-if="providers.length" class="text-[0.62rem] text-muted max-md:hidden">via JustWatch</span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ExtInfo, Provider } from "./api";
import type { RatingSource } from "./fields";
import {
  orderedSources, nativeFormat, storedFormat, toneOf, driftOf, TONE_CLASS, RATING_SOURCES,
} from "./ratings";

const props = defineProps<{
  rating: number; // the stored Rating field, 0–100 (-1 = unset)
  source: RatingSource;
  info: ExtInfo | null;
  mobile: boolean;
}>();

const KIND_LABEL: Record<Provider["kind"], string> = {
  flatrate: "subscription",
  free: "free",
  ads: "free with ads",
};

const chips = computed(() => {
  const all = orderedSources(props.source);
  return props.mobile ? all.slice(0, 1) : all;
});
const val = (k: RatingSource) => props.info?.ratings?.[k] ?? null;
const drift = computed(() => driftOf(props.rating, props.info?.ratings ?? null, props.source));
const leadTip = computed(() => {
  if (drift.value === null) return "Used for the Rating field · change in Settings";
  const name = RATING_SOURCES.find((s) => s.key === props.source)!.name;
  return `Edited — ${name} says ${nativeFormat(props.source, drift.value)}`;
});
const providers = computed(() => props.info?.providers?.list ?? []);
const watchLink = computed(() => props.info?.providers?.link ?? "");
</script>
