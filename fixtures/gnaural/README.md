# The upstream Gnaural preset collection

24 presets from the `Mindstates/` folder of
<https://sourceforge.net/projects/gnaural/files/Presets/>, the download area of Bret Logan's Gnaural
project — about 10 hours of material per pass. **The files are byte-for-byte as published.** Only
their names changed, to the kebab-case stems that are this app's program ids
(`src/library/programs.ts`).

They are split by who signed them: **ten are Gnaural's own** (`<author>Gnaural</author>`, Bret
Logan) and **fourteen were contributed to the project** by other people. That is the only
categorisation, and it comes from the `<author>` field rather than from a judgement about the
programs.

Three of the ten — `dream`, `energize` and `problem-resolver` — come from the `Mindstates/android/`
subfolder rather than from `Mindstates/` itself, which is why `sourceFile` records a path for them.
That folder is the loose form of `android_presets.zip`, and it holds fourteen files, all signed
`Gnaural` and none of them carrying a PCM voice. Seven are re-cuts of presets already here — Power
Nap, the travel aid, the default schedule, Tibetan Bowl, Study Time, Instant Nap and the wakeup
preset, each a different file from its `Mindstates/` namesake but the same programme. Four more are
nature beds built out of noise voices — `baa_wind_and_waves`, `caa_spring_rain`, `laa_rain_shower`
and `maa_babbling_brook`, three of which ship their optional binaural voice muted. They are
soundscapes by function and stay out for the same reason `Soundscapes/` does, below. That leaves
these three, which duplicate nothing.

`manifest.json` carries what `.gnaural` has no field for: that split, the original filename, the
download URL, and the date it was uploaded to SourceForge. Everything else in it — title, author,
description, duration, loops — is read out of the file itself rather than transcribed, because the
headers are not reliable: `solfeggio-derived-tones` declares 720 s and runs 542, and
`academic-performance-enhancement` declares 3 entries and has 31. The only edited field is a title
that would otherwise appear twice in the library, which gains its source in parentheses.

## Not bundled: `Soundscapes/`

Upstream's second folder holds 15 sound compositions rather than binaural-beat programs — carriers
at 1.9 kHz, beats at 57 Hz, entries a tenth of a millisecond long, schedules that loop thousands of
times. They were bundled briefly and dropped: this app is a binaural-beat player, and those files
are something else. They are still upstream if anyone wants them, and they import fine.

Nine of the ten zips upstream — `ForestMeditation.zip`, `ForestMeditation_android.zip`,
`SummerSunshineMeditation.zip`, `ThetaGnauralPresetforSkilledRelaxation.zip`, `*_ISO_BIN.zip` and
`woods.zip` — pair a schedule with an `.ogg` or `.wav` and stay out for a different reason again:
each holds type-2 PCM voices, thirty of them in `ForestMeditation`, and PLAN.md §4.6 keeps the app
synthetic. The tenth, `android_presets.zip`, holds no audio at all; its three unique programs are
bundled and the rest is accounted for above.

## These predate the Android app

Two of these are the originals of files the Android app `com.ihunda.android.binauralbeat`
redistributed after editing, and which this project has been carrying under its name in
`../presets/`:

| Upstream | Uploaded | This app also has |
|---|---|---|
| `power-nap.gnaural` | 2011-08-08 | `../powernap.gnaural` — the Android copy, with its water-drops and rain voices removed and a stale 3-voice header left behind |
| `airplane-travel-aid.gnaural` | 2010-10-11 | `../airplanetravelaid.gnaural` — the Android copy, with `<author>` changed to `@Gnaural` and the description rewritten |

Both copies are kept, because both are real, and both titles name the collection they come from —
"Power Nap (Gnaural)" against "Power Nap (Android)" — since otherwise the library would list the
same title twice. `Mindstates/android/` in upstream's own download area settles the direction: the
`.gnaural` files the Android app shipped came from here.

## What this corpus contains that the Android set does not

Facts that several comments elsewhere in the codebase are measured against, so they are recorded
here rather than rediscovered:

- **Every voice type but PCM.** Types 0, 1, 3, 4, 5 and 6 all appear; type 2 appears nowhere, so
  the whole collection is renderable (`isRenderableType`, `src/document/types.ts`).
- **Zero-length entries are ordinary** — 77 of them across nine files. That is how Gnaural's own
  editor writes an instantaneous jump; the Android set has none.
- **Values outside §6.1's advice, on purpose.** Seven files raise a frequency rule: `tibetan-bowls`
  is built from carriers below 20 Hz, `purr` gates a 493 Hz tone. Thresholds are unchanged and
  these are not defects.
- **Panning.** Nine files set the two channels differently, `hypnagogic-gale` at 10,049 entries.
  The Android set is centred throughout.
- **Schedules that loop.** Nothing in the Android set repeats; eight of these do, `purr` and
  `study-time` endlessly, which is what the engine's pass bound exists for (`passCount`,
  `src/engine/engine.ts`).
- **Size.** Four are past the 8 KB share-link guard and fall back to file export;
  `hypnagogic-gale` is 10,080 entries.

## Licence and attribution

Gnaural is GPLv2 (`../../reference/gnaural-src-20110606/COPYING`) and these presets were published
by their authors on the project's own download area, which invites submissions for redistribution
("If you have created a preset that you feel might benefit others by being posted here, submit it
to: gnaural [at] users.sourceforge.net" — `Presets/README.txt`). No preset carries a licence of its
own.

**Attribution is owed independently of the licence.** Thirteen names appear across the 24 `<author>`
fields — Gnaural (Bret Logan), asymptote, josh k, flexusfly, Dane M, Roisin, Hipponotic, Giridhari,
Willow Oak, Sleeper, Mihai Dinca and curtismacdonald.com. Every one is preserved in the file and in
`manifest.json`, and `src/library/programs.test.ts` fails if one goes missing. The titles and
descriptions are those authors' prose, shown as their words rather than as claims this app makes.
