# hindcaster-canada

The Canadian collector for [Hindcaster](https://hindcaster.baish.net/), a
personal project by John Baish that shows yesterday's and last night's weather.
This repo is public so that GitHub's free runners can be used. The main
Hindcaster repo (England) is private.

**Status:** probe stage. Nothing is collected on a schedule yet. The scope and
decisions are in Hindcaster's `design/canada-scope-2026-10-23.md`.

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
