# No Doubters

Every MLB home run from a given day, sortable by distance, time, team, and player, with the official MLB highlight clip inline.

Static site — no build step, no backend, no API keys. Data comes directly from the public MLB Stats API:

- `statsapi.mlb.com/api/v1/schedule` — the day's games
- `statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live` — plays with Statcast `hitData`
- `statsapi.mlb.com/api/v1/game/{gamePk}/content` — highlight clips, matched to plays by `guid` = `playId`

## Run locally

    python3 -m http.server 8000

then open http://localhost:8000

## Season data

`data/season.json` holds every home run of the season. `scripts/update-season.mjs` rebuilds it
from the MLB API (defaults to the last 3 days; pass two dates for a range). A GitHub Action in
`.github/workflows/update-season.yml` runs it every morning and commits the result.

## Deploy

Hosted on GitHub Pages from the `main` branch root. Push to `main` to deploy.

Not affiliated with MLB. Video and data are MLB property; personal, non-commercial use only.
