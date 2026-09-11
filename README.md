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

## Park data, victims, share pages, embed

- `scripts/fill-parks.mjs <year>` joins Baseball Savant's per-homer park counts (`parks`, 0–30; `cat`) and
  pitcher IDs into a season file. The daily Action runs it for recent homers; the backfill Action runs it per season.
- The Victims tab is the same data shown by pitcher. `build-all.mjs` writes `data/all/pitchers/`.
- `build-pages.mjs` writes `hr/<playId>/` share pages with preview tags for the current season and all-time lists.
- `embed/` is the embeddable widget; `embed/get.html` explains it.

## Tweets

`scripts/tweet-nostalgia.mjs` posts once a day to @NoDoubtersMLB: the longest home run hit on
today's calendar date in a randomly chosen past season, uploaded as native video, with a link
back to the site in a self-reply. `.github/workflows/tweet-nostalgia.yml` schedules it for
9am Pacific. Needs X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET as repository
secrets. A year never repeats on the same date until every season has had a turn.

Nov 6 - Mar 18 has no games on any calendar date. `OFFSEASON` in the workflow env controls
what happens then: `vault` (default) posts a random 450+ homer from the archive, `skip` goes
quiet, `nearest` borrows the closest date that has games.

The Cloudflare Worker in `worker/` no longer tweets — its cron triggers are removed. It stays
deployed because `index.html` calls its `/parks` endpoint for live park counts on today's board.
Note the deployed version is ahead of the copy in this repo.

## Deploy

Hosted on GitHub Pages from the `main` branch root. Push to `main` to deploy.

Not affiliated with MLB. Video and data are MLB property; personal, non-commercial use only.
