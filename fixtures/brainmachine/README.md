# The Brain Machine sequences

Three programs converted from the Arduino sketches of Mitch Altman's **Brain Machine kit**,
<https://github.com/maltman23/Brain_Machine_kit> — an open-hardware Sound & Light Machine that
plays a binaural beat through earbuds while two LEDs blink at the same rate in front of closed
eyes. About 1.7 hours of material.

Each sketch carries a `brainwaveTab[]`: a flat list of `{ band, duration }` steps, where the band is
one of five letters and the duration is in tenths of a millisecond (÷10,000 → seconds). That table
is the program; everything else in the sketch is the firmware that plays it.

| Program | Sketch | Rows | Blocks | Entries | Length |
|---|---|---|---|---|---|
| `brain-machine-meditation` | `Arduino/BrainMachine/BrainMachine.ino` | 43 | 43 | 86 | 856 s (14 m 16 s) |
| `brain-machine-sleep` | `Arduino/BrainMachineSleep/BrainMachineSleep.ino` | 69 | 59 | 118 | 1776 s (29 m 36 s) |
| `brain-machine-gamma` | `Arduino/BrainMachineGamma/BrainMachineGamma.ino` | 10 | 5 | 10 | 3612 s (60 m 12 s) |

`manifest.json` carries what `.gnaural` has no field for: the sketch each program came from, its
URL, and the row count of its table. Title, author, description, duration and loops are also there
so the library can be listed without parsing anything.

## Conversion

**One binaural voice, base 100 Hz.** The sketch sets `centralTone = 100.0` and plays
`centralTone + beat/2` in the left ear against `centralTone - beat/2` in the right. Gnaural is
symmetric about `basefreq` with the left channel high (PLAN.md §3.6), so this is the same
assignment written a shorter way: `basefreq="100"`, `beatfreq` per band, no `stereoswap`.

**The five bands are the values the sketch documents**, which are also the ones its LED blink
timings are calculated from:

| Band | `bwType` | Beat | Left / right |
|---|---|---|---|
| Gamma | `g` | 40.0 Hz | 120.00 / 80.00 |
| Beta | `b` | 14.4 Hz | 107.20 / 92.80 |
| Alpha | `a` | 11.1 Hz | 105.55 / 94.45 |
| Theta | `t` | 6.0 Hz | 103.00 / 97.00 |
| Delta | `d` | 2.2 Hz | 101.10 / 98.90 |

**Runs are merged.** Adjacent rows of the same band are one block — the sleep table writes
`{ 't', 600000 }` up to five times in a row where it wants a five-minute stretch of theta, and that
is a single flat entry here. Nothing is lost: a merged block plays exactly what the run played.

**Step shape via epsilon pins.** A Gnaural entry ramps to the *next* entry's value over its own
duration, and these blocks are flat, so each one is followed by a `0.001 s` breakpoint holding the
same value. The jump to the next band then happens across that 1 ms sliver rather than across the
whole block. Same technique, and same reasoning, as `../presets/README.md`. It puts `0.001 ×
blocks` on the end of each file — `totaltime` is 856.043, 1776.059 and 3612.005 against table
totals of 856, 1776 and 3612 — and the terminal pin confines §3.5's unconditional wrap back to the
first entry's value to that same 1 ms.

## What did not survive

**The lights.** Half of a Sound & Light Machine is photic: the LEDs blink at the beat frequency
(`blink_LEDs`, and an unused `alt_blink_LEDs` for alternating left/right that none of the three
tables calls for). This app has no visual output and is not going to grow one — a full-screen
strobe in a browser is a different safety proposition from a pair of LEDs behind sunglasses, on
hardware whose own README warns about seizures. **These files are the sound half only, and are
weaker for it**; the sequences were designed to be heard and seen at once.

**The square waves.** The Arduino `Tone` library switches a pin, so the kit plays square waves
through a resistor into earbuds. These play as sines, like everything else here.

**The integer truncation, deliberately.** `Tone::play()` takes an integer frequency, so a real
Brain Machine rounds every pitch down: alpha is 94/105 rather than 94.45/105.55, which is an 11 Hz
beat on a 99.5 Hz carrier, and beta lands on 15 Hz rather than 14.4. The ported files use the
documented values — the sketch's stated intent, the kit README's table, and what the LED timings
were computed from — rather than reproducing an artefact of the AVR's tone generator.

**One research claim.** The kit README introduces the gamma sequence with early Alzheimer's and
brain-fog research. The program's description here says what the sequence *is* and nothing about
what it may do, per PLAN.md §2. The meditation and sleep descriptions are the kit README's own
prose, verbatim, typos and all — as with the rest of the corpus, they are their author's words
rather than claims this app makes.

**A 100 Hz carrier is low**, and on small drivers a sine there is much quieter than a square was.
That is fidelity, not an oversight: the kit README notes the central pitch is a matter of taste and
suggests 100–220 Hz. Anything higher is a retune away in the editor.

## Licence and attribution

The Brain Machine kit is **CC BY-SA 4.0** (<https://creativecommons.org/licenses/by-sa/4.0/>).

The lineage, from the kit's own README:

- **Mitch Altman** built the original Sound & Light Machine in the early 1990s, hacked it onto
  Adafruit's MiniPOV3 in 2007, and wrote it up for MAKE Magazine #10
  (<https://makezine.com/article/home/fun-games/the-brain-machine/>). The meditation sequence is his,
  recorded from his own EEG.
- **Limor Fried** ("Ladyada") co-created the 2010 Adafruit Brain Machine kit with him
  (<https://www.adafruit.com/product/287>).
- **Chris Sparnicht** ("Laughter On Water") ported it to Arduino in 2011
  (<https://github.com/LaughterOnWater/Arduino-Brain-Machine>), under CC BY-SA 2.5; Mitch modified
  that sketch into the 2025 kit's firmware, which is what was read here.

`<author>` is `Mitch Altman` in all three files and **must not be stripped** —
`src/library/programs.test.ts` fails if a credit goes missing. As with the other collections, the
frequency and duration data is a list of numbers describing a physical process; the descriptions
are the copyrightable prose, quoted and attributed.

No firmware, schematic or artwork from the kit is vendored — only the three tables were read. The
repository is worth a look on its own account if you want to build one.
