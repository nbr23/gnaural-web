# Bundled presets

17 programs converted from the Android predecessor's built-in preset library
(`DefaultProgramsBuilder.java`) into standard `.gnaural` schedules. Together with
`../powernap.gnaural` and `../airplanetravelaid.gnaural` — which the Android app also shipped,
already in Gnaural format — this is the complete built-in library, 19 programs and about 14
hours of material.

**Read the licence section at the bottom before shipping these.** It is not a formality; the
descriptions in particular carry a real constraint.

| Category | Count |
|---|---|
| Stimulation | 5 |
| Meditation | 4 |
| OOBE | 3 |
| Sleep | 2 |
| Healing, Hypnosis, Learning | 1 each |

`manifest.json` carries the per-preset metadata that `.gnaural` has no field for — category,
originating Java method, background loop, and conversion caveats. Use it to build the program
list; use the `.gnaural` files for playback.

## Why these are `.gnaural` and not a bespoke format

Converting means the app needs exactly one parser and one document model. The presets become
ordinary user-editable schedules in Phase 1, exportable and shareable like anything else, with
no second code path. The conversion is lossless for the tone content (verified below), so there
was no reason to invent a format.

## Conversion rules

The Android model was `Program → Period → BinauralBeatVoice`, where a `Period` is a block of
fixed duration and each voice within it ramps its beat frequency linearly from `freqStart` to
`freqEnd`. That is already breakpoint-shaped, so the mapping is direct — with four wrinkles.

### 1. Asymmetric carriers — the important one

The Android engine generated:

```
LEFT = carrier + beat        RIGHT = carrier
```

Gnaural is symmetric about the base frequency (PLAN.md §3.6):

```
LEFT = base + beat/2         RIGHT = base − beat/2
```

Setting `base = carrier + beat/2` reproduces **both pitches exactly**, not merely the same
perceived beat. Because `base` and `beat` both interpolate linearly and `base` is defined in
terms of `beat`, the identity holds continuously across a ramp, not just at the breakpoints.

Verified numerically against a reimplementation of the Android interpolation: worst deviation
across the sampled programs is **5×10⁻⁵ Hz**, arising solely from wrinkle 3 below.

### 2. Default carrier frequencies

Voices without an explicit pitch got a carrier from their *index*, via
`VoicesPlayer.voice2Note()` — a chord, tuned to **A = 432 Hz**, not 440:

| Voice | Note | Hz |
|---|---|---|
| 0 | A4 | 432.00 |
| 1 | C4 | 513.74 |
| 2 | E4 | 647.27 |
| 3 | G4 | 769.74 |
| 4 | C5 | 1027.49 |
| 5 | E6 | 2589.07 |
| 6+ | A7 | 3456.00 |

These are baked into the converted files as explicit `basefreq` values, so the 432 Hz tuning is
preserved without the web app needing to know anything about it.

### 3. Epsilon pins

Gnaural has no way to express an instantaneous jump: a breakpoint's value ramps to the *next*
breakpoint's value over its full duration. Where an Android period ended at a value different
from the next period's start — a deliberate discontinuity — a `0.001 s` breakpoint pins the true
end value so the ramp shape is preserved on both sides. Inaudible, and the only source of the
5×10⁻⁵ Hz deviation above.

A terminal pin also appears at the end of every file. This confines PLAN.md §3.5's
unconditional wrap-to-first-entry to a 1 ms sliver rather than letting it ramp backwards across
the whole final period.

### 4. Voice lengths are equalised

Per PLAN.md §3.7 the *shortest* voice ends a schedule, so the epsilon pins would otherwise
truncate the noise lane. Each lane's final entry absorbs the difference; every voice in every
file totals exactly `totaltime`. Verified for all 17 files.

## What did not survive conversion

**`SoundLoop.UNITY` — dropped deliberately.** Four presets (`healing-morphine`,
`meditation-unity`, `oobe-lucid-dreams-2`, `sleep-sleep-induction`) used a looping ambient ogg
as their background bed instead of noise. The asset is **not** carried into this project and
neither is any mechanism to play it — see PLAN.md §4.6, which keeps the app purely synthetic.

These four are converted with their binaural content fully intact and no background bed. They
will sound barer than they did on Android. That is the intended outcome, not a defect — do not
"fix" it by reintroducing an asset pipeline.

If any of them turns out to feel too exposed in listening tests, the app-level noise layer
(PLAN.md §4.5b) provides a bed with no asset. The original per-period gains are recoverable
from `DefaultProgramsBuilder.java` if anyone ever wants them as a starting point; they ran 0.5
to 0.7, and `oobe-lucid-dreams-2` varied its bed across 24 segments.

`SoundLoop.PINK_NOISE` and `BROWN_NOISE` existed in the enum but no preset used them.

**Per-period fade envelopes.** The Android player applied its own fades between periods
(1000 ms at program boundaries, 2500 ms between periods, floor 0.6). These were a property of
the playback engine, not the program data, and are not represented. If Phase 0's playback of
these presets sounds abrupt at period boundaries, that is why — the fix belongs in the engine as
a general policy, not in these files.

## Regenerating

`tools/extract_presets.py` in the Android repo, run from its root. It is included for
provenance and is not needed to build the web app — the `.gnaural` files are the deliverable.

## Licence — read this

These presets are **not** public domain and are **not** yours to relicense freely.

- **Source:** `DefaultProgramsBuilder.java` from Binaural Beats Therapy, **GPLv3**, originally by
  Giorgio Regni.
- **Attribution:** 9 presets credit `@GiorgioRegni`, 7 credit `@thegreenman`, 1 is uncredited.
  The `<author>` field is preserved in every file and **must not be stripped**.
- **Third-party lineage:** `healing-morphine` carries a source comment pointing at
  `bwgen.com/presets/desc263.htm` — a BrainWave Generator preset. Its provenance upstream of the
  Android app is unverified.
- **No audio assets are shipped**, which removes the worst of the licence exposure. The Android
  app's ambient ogg had no attribution anywhere in its repo — no credit, licence note, or
  source — and a recorded sample is far more clearly copyrightable than a list of frequencies.
  Dropping it was the right call on those grounds alone.

The distinction that matters:

- **The frequency and duration data** is arguably uncopyrightable — a list of numbers describing
  a physical process, with no creative expression in the arrangement beyond the functional. Weak
  claim either way; unlikely to be contested.
- **The descriptions are copyrightable prose.** "Wander in deep relaxing delta waves and let
  your mind explore freely and without bounds" is creative writing, reproduced verbatim in the
  `<schedule_description>` of every file. This is the actual exposure.

Practical consequences:

1. **If the web app is GPLv3, everything here is fine as-is.** This is the path of least
   resistance and PLAN.md §10 already recommends GPL.
2. **If you want a permissive licence, rewrite the descriptions in your own words.** They are 17
   short paragraphs. Keep the `<author>` credits regardless — attribution is owed independently
   of the licence question.
3. **Do not relicense the preset data as MIT/BSD without deciding this deliberately.** Ask the
   project owner; it is not the implementer's call.

Note that this constraint is *narrower* than the one on `../../reference/`: there the concern is
transcribing GPLv2 algorithms, here it is reproducing GPLv3 prose. They are separate questions
and both need answering before publication.
