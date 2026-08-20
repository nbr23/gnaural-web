# Gnaural Web

A browser-based player for Gnaural binaural-beat schedules — 100% client-side, installable as a PWA.

## Run it

```sh
docker run -p 8080:80 nbr23/gnaural-web:latest   # http://localhost:8080
```

## Render from the command line

Same engine as the app, offline and faster than realtime:

```sh
docker run --rm -v "$PWD:/programs" nbr23/gnaural-web:cli powernap.gnaural -o powernap.mp3
docker run --rm nbr23/gnaural-web:cli --help
```

WAV or MP3, `--rate`, `--quality`, and `--noise <colour>[:<gain>]` for the app's noise bed. From a
checkout it is `npm run render -- fixtures/powernap.gnaural -o /tmp/nap.wav`.

## Develop

```sh
npm install && npm run dev     # http://localhost:5173
npm test
npm run build

docker compose up dev                        # the same, without a local Node
docker compose --profile test run test
docker compose --profile preview up preview  # production build via nginx on :8080
```

## Credits

- **[Gnaural](https://gnaural.sourceforge.net/)** by Bret Logan — the `.gnaural` file format and
  the reference implementation (release 20110606) this project is built against, and the
  [preset collection](https://sourceforge.net/projects/gnaural/files/Presets/) shipped unmodified
  in `fixtures/gnaural/` — 24 programs, ten of them Gnaural's own and fourteen contributed to the
  project by other people. Thirteen authors are credited; see that directory's README.
- **Binaural Beats Therapy** (`com.ihunda.android.binauralbeat`) by Giorgio Regni — the Android
  app the presets in `fixtures/presets/` are derived from. Two of the files it shipped are edited
  copies of Gnaural presets, and both originals are bundled too.

## Licence

GPL-3.0-or-later — see [LICENSE](LICENSE).
