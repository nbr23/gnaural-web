# Bundled presets

17 programs converted from the Android predecessor's built-in library
(`DefaultProgramsBuilder.java`) into standard `.gnaural` schedules. With `../powernap.gnaural`
and `../airplanetravelaid.gnaural` — which that app also shipped, already in Gnaural format —
this is the complete bundled library: 19 programs, about 14 hours of material.

`manifest.json` carries the per-preset metadata `.gnaural` has no field for: category,
originating Java method, background loop, and conversion caveats. The program list is built from
it; playback uses the `.gnaural` files.

## Conversion

The Android model was `Program → Period → BinauralBeatVoice`, where a period is a block of fixed
duration and each voice ramps its beat frequency linearly from `freqStart` to `freqEnd`. That is
already breakpoint-shaped, so the mapping is direct apart from four things.

**Asymmetric carriers.** The Android engine generated `LEFT = carrier + beat`, `RIGHT = carrier`;
Gnaural is symmetric about the base frequency (PLAN.md §3.6). Setting `base = carrier + beat/2`
reproduces *both pitches* exactly, not merely the same perceived beat, and because `base` and
`beat` both interpolate linearly the identity holds continuously across a ramp. Verified against
a reimplementation of the Android interpolation: worst deviation 5×10⁻⁵ Hz.

**Default carriers are tuned to A = 432 Hz.** Voices without an explicit pitch took a carrier
from their index via `VoicesPlayer.voice2Note()` — a chord at 432, not 440:

| Voice | 0 | 1 | 2 | 3 | 4 | 5 | 6+ |
|---|---|---|---|---|---|---|---|
| Note | A4 | C4 | E4 | G4 | C5 | E6 | A7 |
| Hz | 432.00 | 513.74 | 647.27 | 769.74 | 1027.49 | 2589.07 | 3456.00 |

These are baked in as explicit `basefreq` values, so nothing in the app needs to know about the
tuning.

**Epsilon pins.** Gnaural cannot express an instantaneous jump — a breakpoint ramps to the next
one's value over its full duration. Where an Android period ended at a value different from the
next period's start, a `0.001 s` breakpoint pins the true end value so the ramp shape survives on
both sides. Inaudible, and the sole source of the deviation above. A terminal pin also ends every
file, confining PLAN.md §3.5's unconditional wrap-to-first-entry to a 1 ms sliver.

**Equalised voice lengths.** Per PLAN.md §3.7 the shortest voice ends a schedule, so the pins
would otherwise truncate the noise lane. Each lane's final entry absorbs the difference; every
voice in every file totals exactly `totaltime`.

## What did not survive

**`SoundLoop.UNITY`, dropped deliberately.** Four presets (`healing-morphine`,
`meditation-unity`, `oobe-lucid-dreams-2`, `sleep-sleep-induction`) used a looping ambient ogg as
their background bed instead of noise. Neither the asset nor any mechanism to play it is carried
over — PLAN.md §4.6 keeps the app purely synthetic. Their binaural content is intact; they simply
sound barer than they did on Android. That is intended, not a defect: do not "fix" it by
reintroducing an asset pipeline. The app-level noise layer (PLAN.md §4.5b) gives a bed with no
asset if one is wanted. `PINK_NOISE` and `BROWN_NOISE` existed in the enum but no preset used
them.

**Per-period fade envelopes.** The Android player applied its own fades between periods (1000 ms
at program boundaries, 2500 ms between periods, floor 0.6). Those were a property of its playback
engine, not of the program data, and are not represented here. If these presets sound abrupt at
period boundaries, the fix belongs in the engine as a general policy, not in these files.

## Licence

Derived from `DefaultProgramsBuilder.java` (Binaural Beats Therapy, **GPLv3**, Giorgio Regni),
which is why this project is GPLv3.

The frequency and duration data is a list of numbers describing a physical process and arguably
uncopyrightable. **The descriptions are copyrightable prose**, reproduced verbatim in each file's
`<schedule_description>` — that is the real exposure, and it is fine as-is under GPLv3. A
permissive relicence would mean rewriting those 17 short paragraphs first.

Attribution is owed independently of the licence: 9 presets credit `@GiorgioRegni`, 7 credit
`@thegreenman`, 1 is uncredited. The `<author>` field is preserved in every file and **must not
be stripped** — `src/library/programs.test.ts` fails if one goes missing.

`healing-morphine` carries a source comment pointing at `bwgen.com/presets/desc263.htm`, a
BrainWave Generator preset. Its provenance upstream of the Android app is unverified.

No audio assets are shipped, which removes the worst of the exposure: the ambient ogg had no
attribution anywhere in the Android repo, and a recorded sample is far more clearly copyrightable
than a list of frequencies.
