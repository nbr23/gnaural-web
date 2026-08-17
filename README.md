# Gnaural Web

A browser-based player for Gnaural binaural-beat schedules — 100% client-side, installable as a PWA.

## Run it

```sh
docker run -p 8080:80 nbr23/gnaural-web:latest   # http://localhost:8080
```

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
  the reference implementation (release 20110606) this project is built against.
- **Binaural Beats Therapy** (`com.ihunda.android.binauralbeat`) by Giorgio Regni — the Android
  app the bundled presets in `fixtures/presets/` are derived from.

## Licence

GPL-3.0-or-later — see [LICENSE](LICENSE).
