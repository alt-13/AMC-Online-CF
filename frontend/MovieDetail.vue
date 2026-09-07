<!--
  MovieDetail.vue — edit one movie: poster (upload / from-URL / OMDb), every
  scalar field (grouped, honouring the per-user visibility settings), custom
  fields, plus delete. Explicit Save (PUT /api/movies/:id). Poster changes are
  binary side-effects and persist immediately; text edits wait for Save.

  Layout is a deliberate visual match of the self-hosted MovieForm.vue: the same
  header (inline poster + meta pills + rating badges + watched badge + colour
  dot), the same two-column body in the same field order, and the same 4-column
  media grid — built on PrimeVue form controls + inline Tailwind utilities so it
  matches the themed CinemaPreset look.

  Not ported: the Extras editor is edit-only in the UI; the Worker only writes
  extras on import (insertExtras) — a PUT path is wired through updateMovie here.
-->
<template>
  <div class="flex flex-col h-full overflow-hidden bg-bg">
    <div v-if="loading" class="p-8 text-muted text-sm">Loading…</div>

    <template v-else>
      <!-- ── Header ── -->
      <div
        class="flex items-start justify-between gap-4 px-5 pt-4 pb-3 bg-surface border-b border-border shrink-0
               max-md:items-center max-md:gap-2 max-md:px-2 max-md:py-1.5 max-md:max-h-[20vh] max-md:overflow-hidden"
      >
        <!-- Poster ↔ title gap is fluid, not a breakpoint step: `main`'s
             `.header-left` used a flat 1rem that dropped to 0.5rem under 768px,
             and at both ends the poster read as glued to the title. `clamp()`
             in one declaration gives 12px on the narrowest phone, ~17px at the
             breakpoint and 28px on a wide screen — a flex `gap` rather than a
             margin on the poster so the spacing stays a property of the row and
             survives the `max-md` reflow. -->
        <div class="flex gap-[clamp(0.75rem,2.2vw,1.75rem)] flex-1 min-w-0 max-md:items-center max-md:overflow-hidden">
          <!-- Poster panel (inline, 110×160; 64×92 on mobile).
               `max-md:w-auto`: the 110px is the DESKTOP poster's own width, and
               on mobile the poster is 64px wide with the buttons/message below
               it hidden — so a fixed 110px reserved ~46px of dead column that
               the title/meta stack needs. -->
          <div class="flex flex-col items-center gap-1.5 w-[110px] shrink-0 max-md:w-auto">
            <div
              class="group relative w-[110px] h-[160px] rounded-md overflow-hidden bg-elevated border border-border
                     cursor-pointer transition-colors hover:border-gold max-md:w-16 max-md:h-[92px] max-md:shrink-0"
              @click="posterSrc ? (lightboxOpen = true) : triggerUpload()"
            >
              <img v-if="posterSrc" :src="posterSrc" class="w-full h-full object-cover block" alt="Movie poster" />
              <div v-else class="w-full h-full flex flex-col items-center justify-center gap-1.5 text-muted text-[0.7rem]">
                <i class="pi pi-image text-[1.4rem]" />
                <span>Click to upload</span>
              </div>
              <div class="absolute inset-0 bg-black/55 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 text-white text-xl">
                <i :class="posterSrc ? 'pi pi-search-plus' : 'pi pi-upload'" />
              </div>
            </div>
            <input
              ref="fileInput"
              type="file"
              accept="image/*"
              class="hidden"
              @change="onFile"
            />
            <div class="flex gap-0.5 max-md:hidden">
              <Button icon="pi pi-upload" text size="small" title="Upload poster" @click="triggerUpload" />
              <Button icon="pi pi-link" text size="small" title="From URL" @click="fromUrl" />
              <Button v-if="posterSrc" icon="pi pi-trash" text severity="danger" size="small" title="Remove poster" @click="removePoster" />
            </div>
            <p v-if="posterMsg" class="text-[0.7rem] text-muted text-center max-md:hidden">{{ posterMsg }}</p>
          </div>

          <!-- Title + meta + ratings -->
          <div class="flex-1 min-w-0 flex flex-col gap-1.5 pt-1 max-md:overflow-hidden">
            <h1 class="font-display text-[1.35rem] font-bold text-text leading-tight whitespace-nowrap overflow-hidden text-ellipsis m-0 max-md:text-base">
              {{ form.original_title || "Untitled" }}
            </h1>
            <p
              v-if="form.translated_title && form.translated_title !== form.original_title"
              class="text-[0.85rem] text-muted italic m-0 max-md:hidden"
            >{{ form.translated_title }}</p>
            <div class="flex flex-wrap gap-1">
              <span v-if="form.year > 0" class="text-[0.72rem] text-muted bg-elevated border border-border px-[0.45rem] py-[0.1rem] rounded-[10px]">{{ form.year }}</span>
              <span v-if="form.category" class="text-[0.72rem] text-muted bg-elevated border border-border px-[0.45rem] py-[0.1rem] rounded-[10px] max-md:hidden">{{ form.category }}</span>
              <span v-if="form.length > 0" class="text-[0.72rem] text-muted bg-elevated border border-border px-[0.45rem] py-[0.1rem] rounded-[10px]">{{ form.length }} min</span>
              <span v-if="form.director" class="text-[0.72rem] text-muted bg-elevated border border-border px-[0.45rem] py-[0.1rem] rounded-[10px] max-md:hidden">Dir. {{ form.director }}</span>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <!-- On mobile the two score pills lose their "score"/"mine" word
                   and most of their padding: the star/person glyph already says
                   which is which, and at full size the pair plus the meta pills
                   crowded the title out of the header. -->
              <div v-if="form.rating > 0" class="flex items-center gap-1 bg-elevated border border-border px-[0.55rem] py-[0.2rem] rounded-xl text-[0.82rem] font-semibold text-gold
                          max-md:gap-0.5 max-md:px-1.5 max-md:py-0 max-md:text-[0.72rem]">
                <i class="pi pi-star-fill text-[0.7rem] max-md:text-[0.6rem]" />
                {{ (form.rating / 10).toFixed(1) }}
                <span class="font-light text-[0.7rem] text-muted max-md:hidden">score</span>
              </div>
              <div v-if="form.user_rating > 0" class="flex items-center gap-1 bg-elevated border border-border px-[0.55rem] py-[0.2rem] rounded-xl text-[0.82rem] font-semibold text-[#7ec8e3]
                          max-md:gap-0.5 max-md:px-1.5 max-md:py-0 max-md:text-[0.72rem]">
                <i class="pi pi-user text-[0.7rem] max-md:text-[0.6rem]" />
                {{ (form.user_rating / 10).toFixed(1) }}
                <span class="font-light text-[0.7rem] text-muted max-md:hidden">mine</span>
              </div>
              <!-- Watched is a READ-ONLY badge: Date Watched decides it, so
                   there is nothing to click. In the default synced mode it reads
                   the stored `checked` flag rather than the date, so a legacy row
                   ticked in the Delphi app without a date still reads "Watched"
                   and still exports as watched. With `checked_separate` on, the
                   flag no longer means "watched", so the badge reads the date and
                   the flag gets its own "Checked" control in the form.
                   `max-md:hidden` because it is the widest pill in the header
                   and the one a phone least needs: the list row already carries
                   the same `pi pi-eye` marker, and Date Watched (the actual
                   control) is right below in the form. -->
              <div
                v-show="showField('checked')"
                class="flex items-center gap-1 text-[0.78rem] px-2 py-[0.2rem] rounded-[10px] border border-border select-none max-md:hidden"
                :class="watched ? 'text-success border-success/40' : 'text-muted'"
                :title="watched
                  ? 'Watched — set by Date Watched'
                  : 'Not watched — set a Date Watched to mark it'"
              >
                <i :class="watched ? 'pi pi-eye' : 'pi pi-eye-slash'" />
                <span>{{ watched ? "Watched" : "Unwatched" }}</span>
              </div>
              <div
                class="w-3.5 h-3.5 rounded-full border border-white/20 shrink-0 max-md:hidden"
                :style="{ background: colorOf(form.color_tag ?? 0) }"
                :title="colorNameOf(form.color_tag ?? 0)"
              />
            </div>
          </div>
        </div>

        <!-- Mobile: a 2x2 grid of compact buttons, not the old 4-tall column.
             A PrimeVue Button defaults to ~40px tall against the ~30px `.hbtn`
             it replaced, so four of them stacked overran the header's 20vh cap
             and got clipped; two rows of 32px clears it and stays narrower than
             a column of full-size buttons is wide. The `[&>button]` rules size
             all four at once (`w-full` because `.p-button-icon-only` pins an
             explicit 2.5rem width that would otherwise ignore the grid track). -->
        <div
          class="flex gap-1.5 items-start shrink-0 pt-1
                 max-md:grid max-md:grid-cols-2 max-md:gap-1 max-md:pt-0
                 max-md:[&>button]:h-8 max-md:[&>button]:w-full max-md:[&>button]:px-1.5 max-md:[&>button]:text-xs"
        >
          <!-- outlined, not text: these three were `.hbtn` (1px border in the
               label's colour) before the PrimeVue migration, and outlined is
               what the rest of the app uses for a secondary header action. -->
          <Button icon="pi pi-arrow-left" outlined class="hidden max-md:inline-flex" title="Back to list" @click="$emit('back')" />
          <!-- Icon-only on mobile: "Fetch" is the widest of the four labels and
               the bolt glyph is the same one the catalog bar uses for OMDb. -->
          <Button
            icon="pi pi-bolt"
            label="Fetch"
            outlined
            class="max-md:gap-0 max-md:[&_.p-button-label]:hidden"
            title="Fetch from OMDb"
            @click="omdbOpen = true"
          />
          <Button
            :label="saving ? 'Saving…' : dirty ? 'Save' : 'Saved ✓'"
            :loading="saving"
            :disabled="saving || !dirty"
            @click="save"
          />
          <Button icon="pi pi-trash" outlined severity="danger" title="Delete film" @click="deleteOpen = true" />
        </div>
      </div>

      <!-- ── Body ── -->
      <div class="flex-1 overflow-y-auto overflow-x-clip px-3 pt-2 pb-4 flex flex-col gap-1.5 max-md:px-2">
        <div class="flex gap-3 items-stretch min-w-0 mb-2 max-md:flex-col">
          <!-- Left column -->
          <div class="flex-1 min-w-0 flex flex-col gap-[0.18rem] max-md:flex-none">
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Original Title</label>
              <InputText v-model="form.original_title" class="w-full" size="small" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('translated_title')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Translated Title</label>
              <InputText v-model="form.translated_title" class="w-full" size="small" />
            </div>

            <!-- Crew fields alongside Actors -->
            <div
              class="flex flex-row gap-2 items-stretch max-md:flex-col"
              v-show="showField('director') || showField('producer') || showField('writer') ||
                      showField('composer') || showField('actors')"
            >
              <div
                class="flex-[3] flex flex-col gap-[0.18rem]"
                v-show="showField('director') || showField('producer') ||
                        showField('writer') || showField('composer')"
              >
                <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('director')">
                  <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Director</label>
                  <InputText v-model="form.director" class="w-full" size="small" />
                </div>
                <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('producer')">
                  <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Producer</label>
                  <InputText v-model="form.producer" class="w-full" size="small" />
                </div>
                <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('writer')">
                  <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Writer</label>
                  <InputText v-model="form.writer" class="w-full" size="small" />
                </div>
                <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('composer')">
                  <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Composer</label>
                  <InputText v-model="form.composer" class="w-full" size="small" />
                </div>
              </div>
              <div class="flex-[2] flex flex-col gap-[0.18rem] min-w-0" v-show="showField('actors')">
                <span class="text-[0.78rem] text-muted block pl-0.5">Actors</span>
                <Textarea v-model="form.actors" class="w-full flex-1 min-h-[90px] resize-none leading-[1.4]" />
              </div>
            </div>

            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('category')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Category</label>
              <InputText v-model="form.category" class="w-full" size="small" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('country')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Country</label>
              <InputText v-model="form.country" class="w-full" size="small" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('url')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">URL</label>
              <div class="flex items-center gap-1.5 min-w-0 w-full">
                <InputText v-model="form.url" class="w-full" size="small" />
                <a v-if="form.url" :href="form.url" target="_blank" class="text-gold text-[0.85rem] shrink-0 no-underline opacity-80 hover:opacity-100 transition-opacity">
                  <i class="pi pi-external-link" />
                </a>
              </div>
            </div>
            <div class="grid grid-cols-[100px_1fr] items-start gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('description')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap pt-[0.3rem] max-md:text-left max-md:pr-0 max-md:whitespace-normal max-md:pt-0">Description</label>
              <Textarea v-model="form.description" rows="3" autoResize class="w-full" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-stretch gap-1.5 flex-1 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('comments')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap pt-[0.3rem] max-md:text-left max-md:pr-0 max-md:whitespace-normal max-md:pt-0">Comments</label>
              <Textarea v-model="form.comments" class="w-full h-full min-h-[3rem]" />
            </div>
          </div>

          <!-- Right column -->
          <div class="flex-none basis-[300px] min-w-0 flex flex-col gap-[0.18rem] max-md:basis-auto">
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('media')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Media</label>
              <InputText v-model="form.media" class="w-full" size="small" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('date')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Date Added</label>
              <DatePicker v-model="dateAdded" dateFormat="yy-mm-dd" showIcon showButtonBar
                iconDisplay="input" size="small" fluid inputClass="w-full" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('date_watched')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Date Watched</label>
              <DatePicker v-model="dateWatched" dateFormat="yy-mm-dd" showIcon showButtonBar
                iconDisplay="input" size="small" fluid inputClass="w-full" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('year')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Year</label>
              <InputText type="number" class="w-full" size="small"
                :modelValue="String(numOrBlank('year'))"
                @update:modelValue="(v: string | undefined) => setInt('year', v ?? '')" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('length')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Length (min)</label>
              <InputText type="number" class="w-full" size="small"
                :modelValue="String(numOrBlank('length'))"
                @update:modelValue="(v: string | undefined) => setInt('length', v ?? '')" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('rating')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Rating</label>
              <InputText type="number" step="0.1" min="0" max="10" class="w-full" size="small"
                :modelValue="String(ratingDec('rating'))"
                @update:modelValue="(v: string | undefined) => setRating('rating', v ?? '')" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('user_rating')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">My Rating</label>
              <InputText type="number" step="0.1" min="0" max="10" class="w-full" size="small"
                :modelValue="String(ratingDec('user_rating'))"
                @update:modelValue="(v: string | undefined) => setRating('user_rating', v ?? '')" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('certification')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Certification</label>
              <InputText v-model="form.certification" class="w-full" size="small" />
            </div>
            <!-- No "Watched" checkbox: in the default synced mode the flag is
                 derived from Date Watched (set it → watched, clear it →
                 unwatched, see `dateWatched`) and the header badge shows the
                 result, read-only. The "Checked" toggle below appears only when
                 the user has unlinked the two in Settings. -->
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('color_tag')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Color Tag</label>
              <Select
                v-model.number="form.color_tag"
                :options="colorTagOptions"
                optionLabel="label"
                optionValue="value"
                class="w-full"
                size="small"
              >
                <template #value="{ value }">
                  <div class="flex items-center gap-2">
                    <span class="w-3 h-3 rounded-full border border-white/25 shrink-0" :style="{ background: colorOf(value ?? 0) }" />
                    <span>{{ colorNameOf(value ?? 0) }}</span>
                  </div>
                </template>
                <template #option="{ option }">
                  <div class="flex items-center gap-2">
                    <span class="w-3 h-3 rounded-full border border-white/25 shrink-0" :style="{ background: option.color }" />
                    <span>{{ option.label }}</span>
                  </div>
                </template>
              </Select>
            </div>
            <div
              class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0"
              v-show="props.settings.checked_separate && showField('checked')"
            >
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Checked</label>
              <Checkbox
                :binary="true"
                :modelValue="!!form.checked"
                @update:modelValue="(v: boolean) => form.checked = v ? 1 : 0"
              />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('borrower')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Borrower</label>
              <InputText v-model="form.borrower" class="w-full" size="small" />
            </div>
            <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('series_number')">
              <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal" title="On-disk catalog number. Duplicates are allowed — many catalogs use it to group a series. How it maps to the films/series count is yours to set in Settings → Series count.">Number (#)</label>
              <InputText type="number" min="0" :max="MAX_MOVIE_NUMBER" class="w-full" size="small"
                :modelValue="String(form.number)"
                @update:modelValue="(v: string | undefined) => setNumber(v ?? '')" />
            </div>

            <!-- Custom fields -->
            <template v-if="defs.length > 0">
              <div class="text-[0.6rem] font-bold tracking-[0.1em] uppercase text-muted pt-1.5 mt-1 border-t border-border">Custom</div>
              <div
                v-for="def in defs"
                :key="def.tag"
                class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0"
                v-show="showField('custom_' + def.tag)"
              >
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">{{ def.name || def.tag }}</label>
                <div class="flex items-center gap-1.5 min-w-0">
                  <Checkbox v-if="customTypeOf(def.tag) === 'ftBoolean'" :binary="true"
                    :modelValue="custom[def.tag] === '1'"
                    @update:modelValue="(v: boolean) => custom[def.tag] = v ? '1' : '0'" />
                  <InputText
                    v-else
                    class="w-full"
                    size="small"
                    :type="customTypeOf(def.tag) === 'ftInteger' ? 'number' : 'text'"
                    v-model="custom[def.tag]"
                  />
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- ── Media / Technical ── -->
        <div v-show="['media_type','source','disks','size','file_path','video_format',
                      'video_bitrate','resolution','framerate','audio_format',
                      'audio_bitrate','languages','subtitles'].some((k) => showField(k))">
          <div class="flex items-center gap-3 text-[0.62rem] font-bold tracking-[0.12em] uppercase text-muted mt-1">
            <span>Media</span>
            <span class="flex-1 h-px bg-border" />
          </div>
          <div class="grid grid-cols-4 gap-x-3 gap-y-[0.18rem] items-start max-md:grid-cols-2">
            <div class="min-w-0 flex flex-col gap-[0.18rem]">
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('media_type')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Media Type</label>
                <InputText v-model="form.media_type" class="w-full" size="small" />
              </div>
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('source')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Source</label>
                <InputText v-model="form.source" class="w-full" size="small" />
              </div>
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('disks')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Disks</label>
                <InputText type="number" class="w-full" size="small"
                  :modelValue="String(numOrBlank('disks'))"
                  @update:modelValue="(v: string | undefined) => setInt('disks', v ?? '')" />
              </div>
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('size')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Size</label>
                <InputText v-model="form.size" class="w-full" size="small" />
              </div>
            </div>
            <div class="min-w-0 flex flex-col gap-[0.18rem]">
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('file_path')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">File Path</label>
                <InputText v-model="form.file_path" class="w-full" size="small" />
              </div>
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('video_format')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Video Format</label>
                <InputText v-model="form.video_format" class="w-full" size="small" />
              </div>
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('video_bitrate')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Video kbps</label>
                <InputText type="number" class="w-full" size="small"
                  :modelValue="String(numOrBlank('video_bitrate'))"
                  @update:modelValue="(v: string | undefined) => setInt('video_bitrate', v ?? '')" />
              </div>
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('resolution')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Resolution</label>
                <InputText v-model="form.resolution" class="w-full" size="small" />
              </div>
            </div>
            <div class="min-w-0 flex flex-col gap-[0.18rem]">
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('framerate')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Framerate</label>
                <InputText v-model="form.framerate" class="w-full" size="small" />
              </div>
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('audio_format')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Audio Format</label>
                <InputText v-model="form.audio_format" class="w-full" size="small" />
              </div>
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('audio_bitrate')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Audio kbps</label>
                <InputText type="number" class="w-full" size="small"
                  :modelValue="String(numOrBlank('audio_bitrate'))"
                  @update:modelValue="(v: string | undefined) => setInt('audio_bitrate', v ?? '')" />
              </div>
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('languages')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Languages</label>
                <InputText v-model="form.languages" class="w-full" size="small" />
              </div>
            </div>
            <div class="min-w-0 flex flex-col gap-[0.18rem]">
              <div class="grid grid-cols-[75px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0" v-show="showField('subtitles')">
                <label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Subtitles</label>
                <InputText v-model="form.subtitles" class="w-full" size="small" />
              </div>
            </div>
          </div>
        </div>

        <!-- ── Extras ── -->
        <div v-show="showField('extras')">
          <div class="flex items-center justify-between text-[0.62rem] font-bold tracking-[0.12em] uppercase text-muted mt-1">
            <span>Extras</span>
            <Button icon="pi pi-plus" label="Add Extra" outlined size="small" @click="addExtra" />
          </div>
          <div v-if="!extras.length" class="text-muted text-sm py-2">No extras yet.</div>
          <div v-else class="flex flex-col gap-1 mt-1">
            <div v-for="(extra, idx) in extras" :key="idx" class="border border-border rounded-lg overflow-hidden">
              <div class="flex items-center gap-2.5 px-2.5 py-2 bg-elevated cursor-pointer transition-colors hover:bg-border" @click="toggleExtra(idx)">
                <Checkbox :binary="true" :modelValue="!!extra.checked"
                  @update:modelValue="(v: boolean) => extra.checked = v ? 1 : 0" @click.stop />
                <span class="flex-1 min-w-0 text-sm font-medium overflow-hidden text-ellipsis whitespace-nowrap">{{ extra.title || `Extra ${idx + 1}` }}</span>
                <span v-if="extra.tag" class="text-[0.7rem] bg-gold-dim text-gold px-1.5 py-[0.1rem] rounded-lg border border-[rgba(201,168,76,0.3)]">{{ extra.tag }}</span>
                <Button icon="pi pi-trash" text severity="danger" size="small" title="Remove extra" @click.stop="removeExtra(idx)" />
                <i class="pi text-muted text-[0.7rem]" :class="openSet.has(idx) ? 'pi-chevron-down' : 'pi-chevron-right'" />
              </div>
              <div v-show="openSet.has(idx)" class="px-2.5 py-3 bg-card">
                <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-5 items-start">
                  <div class="flex flex-col gap-[0.18rem]">
                    <div class="text-[0.6rem] font-semibold tracking-[0.1em] uppercase text-muted pb-1 border-b border-border mb-1.5">Info</div>
                    <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0"><label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Title</label><InputText v-model="extra.title" class="w-full" size="small" /></div>
                    <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0"><label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Tag</label><InputText v-model="extra.tag" class="w-full" size="small" /></div>
                    <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0"><label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Category</label><InputText v-model="extra.category" class="w-full" size="small" /></div>
                    <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0"><label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">URL</label><InputText v-model="extra.url" class="w-full" size="small" /></div>
                    <div class="grid grid-cols-[100px_1fr] items-center gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0"><label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap max-md:text-left max-md:pr-0 max-md:whitespace-normal">Created By</label><InputText v-model="extra.created_by" class="w-full" size="small" /></div>
                  </div>
                  <div class="flex flex-col gap-[0.18rem]">
                    <div class="text-[0.6rem] font-semibold tracking-[0.1em] uppercase text-muted pb-1 border-b border-border mb-1.5">Notes</div>
                    <div class="grid grid-cols-[100px_1fr] items-start gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0"><label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap pt-[0.3rem] max-md:text-left max-md:pr-0 max-md:whitespace-normal max-md:pt-0">Description</label><Textarea v-model="extra.description" rows="3" autoResize class="w-full" /></div>
                    <div class="grid grid-cols-[100px_1fr] items-start gap-1.5 min-h-[26px] max-md:grid-cols-1 max-md:gap-0.5 max-md:min-h-0"><label class="text-[0.78rem] text-muted text-right pr-1 whitespace-nowrap pt-[0.3rem] max-md:text-left max-md:pr-0 max-md:whitespace-normal max-md:pt-0">Comments</label><Textarea v-model="extra.comments" rows="2" autoResize class="w-full" /></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <p v-if="error" class="text-danger text-[0.82rem] px-5 py-2">{{ error }}</p>

    <OmdbDialog
      v-if="omdbOpen"
      :initial-query="omdbSeed()"
      @close="omdbOpen = false"
      @open-settings="omdbOpen = false; $emit('open-settings')"
      @apply="applyOmdb"
    />

    <ConfirmDialog
      v-if="deleteOpen"
      title="Delete film"
      :message="`Delete “${form.original_title || 'this movie'}”? This cannot be undone.`"
      confirm-label="Delete"
      cancel-label="Cancel"
      danger
      :busy="deleting"
      @confirm="confirmDelete"
      @cancel="deleteOpen = false"
    />

    <ConfirmDialog
      v-if="urlOpen"
      title="Poster from URL"
      message="Paste a direct link to an image. It will be fetched and stored as the poster."
      input
      input-type="url"
      input-placeholder="https://…"
      confirm-label="Fetch"
      cancel-label="Cancel"
      :busy="urlBusy"
      @confirm="submitUrl"
      @cancel="urlOpen = false"
    />

    <!-- Poster lightbox: click the inline poster to view it full-size. -->
    <Teleport to="body">
      <div
        v-if="lightboxOpen && posterSrc"
        class="lightbox fixed inset-0 z-[1000] flex items-center justify-center p-8 bg-[rgba(0,0,0,0.82)] cursor-zoom-out"
        @click="lightboxOpen = false"
      >
        <img
          :src="posterSrc"
          class="lightbox-img max-w-[90vw] max-h-[90vh] object-contain rounded-md shadow-[0_20px_60px_rgba(0,0,0,0.6)] cursor-default"
          alt="Movie poster"
          @click.stop
        />
        <button
          class="absolute top-4 right-4 inline-flex items-center justify-center w-10 h-10 bg-black/50 text-white border border-white/25 rounded-full text-lg cursor-pointer transition-colors hover:bg-black/80 hover:border-gold hover:text-gold"
          title="Close"
          @click="lightboxOpen = false"
        >
          <i class="pi pi-times" />
        </button>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onBeforeUnmount, nextTick } from "vue";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import Select from "primevue/select";
import Checkbox from "primevue/checkbox";
import DatePicker from "primevue/datepicker";
import Button from "primevue/button";
import { cf, session, type MovieRow, type CustomFieldDefRow, type Extra } from "./api";
import { sha256Hex, blobKey, isBlobKey } from "../amc/posterkey";
import OmdbDialog from "./OmdbDialog.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import {
  isVisible, parseCustom, delphiToDate, dateToDelphi, SENTINEL, MAX_MOVIE_NUMBER,
  COLOR_TAG_COLORS, COLOR_TAG_NAMES, type AppSettings,
} from "./fields";

const props = defineProps<{
  movieId: string;
  defs: CustomFieldDefRow[];
  settings: AppSettings;
}>();
const emit = defineEmits<{
  (e: "back"): void;
  // deleteMovie's response carries the catalog's new content_rev too (a delete
  // is a mutation like any other) — same reason as "changed" below.
  (e: "deleted", contentRev?: number): void;
  // The catalog's new revision, so the parent's sync button stays accurate
  // without re-fetching the catalog row after every save.
  (e: "changed", contentRev?: number): void;
  // Bubble the OMDb dialog's "open Settings" request up to MovieListView, which
  // owns the SettingsDialog (this view doesn't) — otherwise the key-setup link
  // in the fetch dialog is a dead end when fetching from the editor.
  (e: "open-settings"): void;
  // Optimistic list sync: the fields the movie list renders, pushed on every
  // edit so the row mirrors the open form instantly — the same immediacy poster
  // changes already have. The parent re-applies this over a server refetch while
  // the detail is still dirty, so a poster-triggered refresh can't clobber
  // unsaved text (this was the OMDb-fetch bug: poster synced, title didn't).
  (e: "live", patch: Partial<MovieRow> & { id: string }): void;
}>();

const loading = ref(true);
const hydrating = ref(false); // suppresses the dirty watcher while load() populates the form
const saving = ref(false);
const dirty = ref(false);
const error = ref("");
const omdbOpen = ref(false);
const deleteOpen = ref(false);
const deleting = ref(false);
const urlOpen = ref(false);
const urlBusy = ref(false);
const lightboxOpen = ref(false);

const form = reactive({} as MovieRow);
const custom = reactive<Record<string, string>>({});
const extras = ref<Extra[]>([]);
const openSet = reactive(new Set<number>()); // which extra panels are expanded

// Colour-tag <Select> options, built once from the shared name table (ascending
// tag order 0..12 — Object.entries preserves the numeric-key order). `color`
// feeds the swatch in the #option/#value slots.
const colorTagOptions = Object.entries(COLOR_TAG_NAMES).map(([n, name]) => ({
  label: name,
  value: Number(n),
  color: COLOR_TAG_COLORS[Number(n)] ?? "transparent",
}));

const fileInput = ref<HTMLInputElement | null>(null);
const posterSrc = ref("");
const posterMsg = ref("");
let objectUrl = "";
// Bumped on every loadPoster() call. The component instance is reused across
// row switches (no :key remount), so several poster fetches can be in flight at
// once and — since they compete with the list's thumbnail fetches — resolve out
// of order. A stale response must not clobber the current movie's poster, so
// each call captures its generation and commits only while it is still latest.
let posterGen = 0;

const mode = ref<"desktop" | "mobile">(
  window.matchMedia("(max-width: 768px)").matches ? "mobile" : "desktop",
);
const _mq = window.matchMedia("(max-width: 768px)");
const _mqListener = (e: MediaQueryListEvent) => { mode.value = e.matches ? "mobile" : "desktop"; };
_mq.addEventListener("change", _mqListener);

// Esc closes the poster lightbox; F6 opens the OMDb fetch dialog (matches the
// self-hosted MovieForm shortcut).
const _keyListener = (e: KeyboardEvent) => {
  if (e.key === "Escape") lightboxOpen.value = false;
  else if (e.key === "F6") { e.preventDefault(); omdbOpen.value = true; }
};
window.addEventListener("keydown", _keyListener);

// Reload whenever the selected movie changes (the component instance is reused
// across row switches — no :key remount).
watch(() => props.movieId, load, { immediate: true });

onBeforeUnmount(() => {
  _mq.removeEventListener("change", _mqListener);
  window.removeEventListener("keydown", _keyListener);
  window.removeEventListener("beforeunload", onBeforeUnload);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});

async function load() {
  loading.value = true;
  hydrating.value = true;
  lightboxOpen.value = false;
  error.value = "";
  try {
    const m = await cf.getMovie(props.movieId);
    // Clear stale keys, then hydrate (reactive object is reused across reloads).
    for (const k of Object.keys(form)) delete (form as Record<string, unknown>)[k];
    Object.assign(form, m);
    for (const k of Object.keys(custom)) delete custom[k];
    Object.assign(custom, parseCustom(m));
    for (const d of props.defs) if (!(d.tag in custom)) custom[d.tag] = "";
    extras.value = (m.extras ?? []).map((e) => ({ ...e }));
    openSet.clear();
    // Show the form as soon as the metadata is in — don't gate it on the poster
    // bytes, which may still be queued behind the list's thumbnail fetches. The
    // poster fills in on its own a moment later.
    loading.value = false;
    void loadPoster(m.poster_key);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    loading.value = false;
  } finally {
    // Start clean; let the hydration mutations flush under `hydrating` so the
    // deep watcher below only flags real user edits afterwards.
    dirty.value = false;
    await nextTick();
    hydrating.value = false;
  }
}

async function loadPoster(key: string | null) {
  const gen = ++posterGen;
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = "";
  }
  posterSrc.value = "";
  if (!key) return;
  try {
    const url = await cf.posterObjectUrl(key);
    // A newer switch started while this fetch was in flight — drop the stale
    // result (freeing its bytes) instead of overwriting the current poster.
    if (gen !== posterGen) {
      URL.revokeObjectURL(url);
      return;
    }
    objectUrl = url;
    posterSrc.value = url;
  } catch {
    /* leave empty */
  }
}

// Flag edits (skips the initial hydrate — dirty is reset at end of load()).
watch([() => ({ ...form }), custom, extras], () => {
  if (!hydrating.value) dirty.value = true;
}, { deep: true });

// Push the list-visible fields to the parent on every change so the row updates
// live — matching how poster changes already appear at once. Guarded by
// `hydrating` (same as the dirty watcher) so a load / server-response sync
// doesn't emit; genuine edits do.
watch(
  () => ({
    original_title: form.original_title,
    translated_title: form.translated_title,
    year: form.year,
    rating: form.rating,
    checked: form.checked,
    color_tag: form.color_tag,
  }),
  (snap) => {
    if (!hydrating.value && form.id) emit("live", { id: form.id, ...snap });
  },
);

// --- extras editing ---------------------------------------------------------
function toggleExtra(i: number) {
  if (openSet.has(i)) openSet.delete(i);
  else openSet.add(i);
}
function addExtra() {
  extras.value.push({
    checked: 0, tag: "", title: "", category: "",
    url: "", description: "", comments: "", created_by: "",
  });
  openSet.add(extras.value.length - 1); // open the new one
}
function removeExtra(i: number) {
  extras.value.splice(i, 1);
  openSet.clear(); // indices shifted — collapse rather than mis-map open state
}

// --- field helpers ----------------------------------------------------------
const showField = (key: string) => isVisible(props.settings, key, mode.value);
const customTypeOf = (tag: string) =>
  props.defs.find((d) => d.tag === tag)?.field_type ?? "ftString";

function colorOf(tag: number): string {
  return COLOR_TAG_COLORS[tag] ?? "transparent";
}
function colorNameOf(tag: number): string {
  return COLOR_TAG_NAMES[tag] ?? "";
}

// --- numeric/date binding helpers ------------------------------------------
const num = (k: string) => Number((form as Record<string, unknown>)[k] ?? 0);
const numOrBlank = (k: string) => (num(k) === SENTINEL ? "" : num(k));
function setInt(k: string, v: string) {
  (form as Record<string, unknown>)[k] = v === "" ? SENTINEL : parseInt(v, 10) || 0;
}
// `number` is not a SENTINEL field — blank means 0, not "unset". Guard both ends:
// a non-numeric paste must not leave NaN sitting in the form (it would render as
// "NaN" until reload), and the value has to stay inside what the .amc's int32
// field can round-trip — the Worker clamps too, this just keeps the input honest.
function setNumber(v: string) {
  const n = Number(v);
  form.number = v === "" || !Number.isFinite(n)
    ? 0
    : Math.min(Math.max(0, Math.trunc(n)), MAX_MOVIE_NUMBER);
}
// <DatePicker> binds a Date; the row stores a Delphi day number.
const dateAdded = computed<Date | null>({
  get: () => delphiToDate(num("date")),
  set: (d) => { form.date = dateToDelphi(d); },
});

// Date Watched drives the `checked` flag (there is no Watched checkbox any
// more): picking a date marks the film watched, clearing it marks it unwatched.
// The header pill stays available for a watch with no known date.
//
// Unless the user has unlinked them: with `checked_separate` on, the date is
// only a date and `checked` is edited by its own toggle in the form.
const dateWatched = computed<Date | null>({
  get: () => delphiToDate(num("date_watched")),
  set: (d) => {
    const days = dateToDelphi(d);
    form.date_watched = days;
    if (!props.settings.checked_separate) form.checked = days ? 1 : 0;
  },
});

// What the header badge means. Synced: the stored flag (so a legacy row with no
// date still reads "Watched"). Separate: the flag is not about watching any
// more, so only the date can answer.
const watched = computed(() =>
  props.settings.checked_separate ? !!num("date_watched") : !!form.checked,
);
const ratingDec = (k: string) => {
  const v = num(k);
  return v > 0 ? v / 10 : "";
};
function setRating(k: string, v: string) {
  const f = parseFloat(v);
  (form as Record<string, unknown>)[k] = v !== "" && f > 0 ? Math.round(f * 10) : SENTINEL;
}

// --- save / delete ----------------------------------------------------------
// Returns true on success, false on failure — the unsaved-changes guard in the
// parent uses this to decide whether "Save & continue" may proceed.
async function save(): Promise<boolean> {
  saving.value = true;
  error.value = "";
  try {
    const patch: Partial<MovieRow> & { extras: Extra[] } = {
      ...form,
      custom_values: JSON.stringify(custom),
      extras: extras.value,
    };
    // content_rev rides along on the update response so the workspace's sync
    // button stays accurate without a separate catalog refetch. Destructure it
    // out before merging so it never lands as a stray key on `form`.
    const { extras: savedExtras, content_rev, ...movieOnly } = await cf.updateMovie(form.id, patch);
    // Syncing the server response back into `form`/`extras` mutates the same
    // reactive sources the dirty watcher tracks, and that watcher runs on the
    // next flush (flush:'pre', async). Without this guard it refires *after* we
    // clear `dirty` and re-flags the form dirty, leaving the Save button active.
    // Mirror load(): suppress the watcher across the sync, clear it after flush.
    hydrating.value = true;
    Object.assign(form, movieOnly);
    extras.value = (savedExtras ?? []).map((e) => ({ ...e }));
    openSet.clear();
    dirty.value = false;
    emit("changed", content_rev);
    await nextTick();
    hydrating.value = false;
    return true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    return false;
  } finally {
    saving.value = false;
  }
}

// Abandon in-flight edits. Every caller navigates away immediately after (a row
// switch reloads the form via the movieId watcher; a close unmounts the
// component), so clearing the flag is enough — the edited values are discarded
// with the view and never persisted.
function discard() {
  dirty.value = false;
}

// beforeunload guard: warn on a real page unload (tab close / reload / external
// nav) while there are unsaved text edits. Browsers only allow the native
// generic prompt here — no custom message or styled dialog is possible — but it
// fires only on actual unload, not on in-app row switches (those are guarded by
// the parent's ConfirmDialog). Poster edits persist immediately, so they never
// set `dirty` and never trigger this.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = ""; // required by Chrome to show the prompt
}
window.addEventListener("beforeunload", onBeforeUnload);

defineExpose({ dirty, save, discard });

async function confirmDelete() {
  deleting.value = true;
  try {
    const contentRev = await cf.deleteMovie(form.id);
    deleteOpen.value = false;
    emit("deleted", contentRev);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    deleteOpen.value = false;
  } finally {
    deleting.value = false;
  }
}

// --- poster actions ---------------------------------------------------------
function triggerUpload() {
  fileInput.value?.click();
}

// Poster changes persist immediately (their own PUT/updateMovie), so syncing
// the local form must NOT flip the text form dirty. Suppress the watcher across
// the mutation and clear the flag only after it has flushed — same guard as
// save()/load(). Keep the window tight (just the mutation), not around the
// preceding network calls, so a concurrent field edit still registers.
//
// Mirror BOTH columns the server writes: poster_key and pic_path. Every poster
// updateMovie call sends pic_path=".jpg" when a key is present and "" when it's
// cleared (rule 4: embedded pictures must round-trip with a non-empty pic_path),
// so the in-memory form matches the D1 row after the write.
async function setPosterKeyQuietly(key: string | null) {
  hydrating.value = true;
  form.poster_key = key;
  form.pic_path = key ? ".jpg" : "";
  await nextTick();
  hydrating.value = false;
}

async function onFile(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  posterMsg.value = "Uploading…";
  try {
    // Re-encode to JPEG in the browser, then content-address it. The key is the
    // hash of the bytes, never the movie id: overwriting a key in place would
    // replace the bytes behind an immutably-cached URL.
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const jpeg = new Uint8Array(
      await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer(),
    );
    const previous = form.poster_key;
    const key = blobKey(session().tenantId, form.catalog_id, await sha256Hex(jpeg));

    await putPoster(key, jpeg);
    const updated = await cf.updateMovie(form.id, { poster_key: key, pic_path: ".jpg" });
    await setPosterKeyQuietly(key);
    await loadPoster(key);
    // Reclaim the old object only if it was a legacy per-movie key (this movie
    // alone could reference it). Blob keys may be shared by identical artwork,
    // so they are left to the GC. Best-effort: the new poster is already live
    // by this point, so a cleanup failure (offline, DNS, CORS, …) must not be
    // reported as a failed edit — it just leaves an orphaned legacy object.
    if (previous && previous !== key && !isBlobKey(previous)) {
      try {
        await cf.deleteLegacyPoster(previous);
      } catch (e) {
        console.warn(`onFile: failed to delete legacy poster ${previous}`, e);
      }
    }
    posterMsg.value = "";
    emit("changed", updated.content_rev);
  } catch (e) {
    posterMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (fileInput.value) fileInput.value.value = "";
  }
}

function fromUrl() {
  urlOpen.value = true;
}
async function submitUrl(url?: string) {
  const u = (url ?? "").trim();
  if (!u) {
    urlOpen.value = false;
    return;
  }
  // Keep the dialog open with a spinner while fetching; applyPosterUrl reports
  // any failure via posterMsg, so close afterwards either way.
  urlBusy.value = true;
  await applyPosterUrl(u);
  urlBusy.value = false;
  urlOpen.value = false;
}

async function removePoster() {
  if (!form.poster_key) return;
  posterMsg.value = "Removing…";
  try {
    const previous = form.poster_key;
    const updated = await cf.updateMovie(form.id, { poster_key: null, pic_path: "" });
    await setPosterKeyQuietly(null);
    await loadPoster(null);
    // Reclaim the old object only if it was a legacy per-movie key (this movie
    // alone could reference it). Blob keys may be shared by identical artwork,
    // so they are left to the GC. Best-effort: the clear has already succeeded
    // by this point, so a cleanup failure (offline, DNS, CORS, …) must not be
    // reported as a failed edit — it just leaves an orphaned legacy object.
    if (previous && !isBlobKey(previous)) {
      try {
        await cf.deleteLegacyPoster(previous);
      } catch (e) {
        console.warn(`removePoster: failed to delete legacy poster ${previous}`, e);
      }
    }
    posterMsg.value = "";
    emit("changed", updated.content_rev);
  } catch (e) {
    posterMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function putPoster(key: string, bytes: Uint8Array) {
  const s = session();
  const res = await fetch("/api/import/poster", {
    method: "PUT",
    headers: {
      "x-poster-key": key,
      "content-type": "application/octet-stream",
      ...(s.authHeader ? { authorization: s.authHeader } : {}),
      "x-tenant-id": s.tenantId,
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`store poster -> ${res.status}`);
}

async function applyPosterUrl(url: string) {
  posterMsg.value = "Fetching…";
  try {
    const updated = await cf.setPictureFromUrl({ ...form } as MovieRow, url);
    await setPosterKeyQuietly(updated.poster_key);
    await loadPoster(updated.poster_key);
    posterMsg.value = "";
    emit("changed", updated.content_rev);
  } catch (e) {
    posterMsg.value = e instanceof Error ? e.message : String(e);
  }
}

// --- OMDb apply -------------------------------------------------------------
// Seed the fetch dialog so it can auto-search on open: an existing IMDb URL wins
// (the dialog fetches it directly), otherwise the original title, otherwise the
// translated title — matching the self-hosted "search title/URL if filled".
function omdbSeed(): string {
  const url = form.url ?? "";
  if (/tt\d+/.test(url)) return url;
  return form.original_title || form.translated_title || "";
}

async function applyOmdb(patch: Partial<MovieRow>, posterUrl: string) {
  Object.assign(form, patch);
  dirty.value = true;
  if (posterUrl) await applyPosterUrl(posterUrl);
}
</script>

<style scoped>
/* Poster lightbox — the fixed-overlay enlarge animation is the one thing plain
   utilities can't express; the positioning/appearance is inline on the elements
   (see the Teleport block), and only the entrance animation lives here. */
.lightbox { animation: lb-fade 0.15s ease; }
.lightbox-img { animation: lb-pop 0.15s ease; }
@keyframes lb-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes lb-pop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }
</style>
