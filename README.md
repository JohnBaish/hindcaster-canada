# hindcaster-canada

The Canadian collector for [Hindcaster](https://hindcaster.baish.net/), a
personal project by John Baish that shows yesterday's and last night's weather.
This repo is public so that GitHub's free runners can be used. The main
Hindcaster repo (England) is private.

**Status:** probe stage. Nothing is collected on a schedule yet. The scope and
decisions are in Hindcaster's `design/canada-scope-2026-10-23.md`.

## Why this is a separate, public repo

Decided on October 23rd 2026 (Hindcaster's
`design/canada-scope-2026-10-23.md`, section 2 and the
cost table; that note is on the unmerged Hindcaster branch
`claude/beautiful-turing-lmvc7u`):

- **Hindcaster's repo has to stay private.** The Met Office
  terms (clause 3.2.2) forbid passing its data on "in
  original form", and that repo stores its raw readings.
- **A private repo gets 2,000 free GitHub Actions minutes a
  month**, and England already uses about a quarter. Canada
  spans six time zones, so it needs many more runs a day;
  in the same repo it could use up the allowance and stop
  England's updates too.
- **In a public repo, GitHub's standard runners are free
  with no monthly limit.** Canada's data licence (ECCC's
  Data Services End-use Licence) allows the readings to be
  published, so a public repo is allowed here.
- **The planned link back:** the collector commits its
  summary here, then calls a Vercel deploy hook (kept as a
  secret in this repo) so Hindcaster's site rebuilds and
  reads the summary. Writing straight into the private
  repo was ruled out: it would need a token with write
  access to it stored in this public repo.

## What is here

- `scripts/probe.mjs` and `.github/workflows/probe.yml` ("Canada probe", Run
  workflow only): asks Environment and Climate Change Canada's GeoMet API how
  many stations report, which fields they fill in, whether they report the
  weather in words, how the API behaves under repeated requests, and how well
  the climate archive covers the same stations. Writes counts to `data/probe/`.
  No key is needed.
- `data/probe/`: the probe's results.

## Which readings are used

Only readings whose own provider is **MSC** (the Meteorological Service of
Canada) are read. NAV CANADA, partner-network and other readings carry an
"All rights reserved" notice, so the probe counts them but never reads their
values, and nothing from them is stored here.

## Credit

Data Source: Environment and Climate Change Canada.
See the [Data Services End-use Licence](https://eccc-msc.github.io/open-data/licence/readme_en/).
This project is independent and is not endorsed by Environment and Climate
Change Canada.
