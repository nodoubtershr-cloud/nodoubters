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

`data/seasons/<year>.json` holds every home run of a season (`index.json` lists the years). `scripts/update-season.mjs` rebuilds it
from the MLB API (defaults to the last 3 days; pass two dates for a range). A GitHub Action in
`.github/workflows/update-season.yml` runs it every morning and commits the result.

## Static pages (SEO)

`scripts/build-pages.mjs` turns `data/season.json` into real HTML pages — `days/`, `players/`, `teams/`,
`season/` — plus `sitemap.xml`, and refreshes the text block on the homepage between the
`prerender` markers. It runs in the daily Action after the data update. Don't hand-edit those folders.

## Tweets

`scripts/tweet-leader.mjs` posts to @nodoubters: the day's longest-HR leader once 5 homers are in,
each lead change after that, and a morning recap. `.github/workflows/tweet-leader.yml` schedules it.
Needs X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET as repository secrets.
Set `LINKS=recap` in the workflow env to link only the recap (cheaper on X's per-URL pricing).

## Deploy

Hosted on GitHub Pages from the `main` branch root. Push to `main` to deploy.

Not affiliated with MLB. Video and data are MLB property; personal, non-commercial use only.
