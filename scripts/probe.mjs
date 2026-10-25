// Canada probe (Hindcaster scope §9 step 1). Run by hand ("Run workflow").
// Asks ECCC's GeoMet API about stations, fields, weather words, request
// limits and the climate archive, and writes counts to data/probe/.
//
// Licence rule (scope §0): only readings whose provider is MSC have their
// values looked at. Other providers are counted, never read: NAV CANADA's and
// the partners' notices say "All rights reserved". This repo is public.
//
// No key is needed. Data Source: Environment and Climate Change Canada.

import { mkdirSync, writeFileSync } from 'node:fs';

const API = 'https://api.weather.gc.ca/collections';
const OUT = process.env.PROBE_OUT ?? 'data/probe';
const GAP_MS = 1000; // pause between requests
const RETRY_WAIT = [2000, 4000, 8000, 16000];
const PAGE = 1000;

const log = { requests: 0, retries: 0, failures: [], statuses: {}, seconds: [], headers: null, rateLimitHeaders: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&').replaceAll('%2C', ',').replaceAll('%2F', '/').replaceAll('%3A', ':');

async function get(path, params) {
  const url = `${API}/${path}?${q({ f: 'json', ...params })}`;
  for (let attempt = 0; ; attempt++) {
    log.requests++;
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
      log.statuses[res.status] = (log.statuses[res.status] ?? 0) + 1;
      if (!log.headers) log.headers = Object.fromEntries(res.headers);
      for (const [k, v] of res.headers) if (/rate|limit|retry|quota|throttl/i.test(k)) log.rateLimitHeaders[k] = v;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      log.seconds.push(+((Date.now() - t0) / 1000).toFixed(2));
      await sleep(GAP_MS);
      return body;
    } catch (e) {
      log.failures.push(`${path} ${params.datetime ?? params.UTC_DATE ?? ''} attempt ${attempt + 1}: ${e.message ?? e}`.slice(0, 200));
      if (attempt >= RETRY_WAIT.length) throw e;
      log.retries++;
      await sleep(RETRY_WAIT[attempt]);
    }
  }
}

async function getAll(path, params) {
  const features = [];
  for (let offset = 0; ; offset += PAGE) {
    const d = await get(path, { ...params, limit: PAGE, offset });
    features.push(...(d.features ?? []));
    if ((d.features ?? []).length < PAGE) return features;
  }
}

const hits = async (path, params) => (await get(path, { ...params, resulttype: 'hits', limit: 1 })).numberMatched;
const tally = (arr) => arr.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
const top = (m, n = 20) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n));
const filled = (v) => v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && v < -1000);
const isMinutely = (v) => String(v).toLowerCase() === 'true';
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');

const result = { ranAt: iso(new Date()) };
const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10); // yesterday, UTC
const lastYearDay = `${+day.slice(0, 4) - 1}${day.slice(4)}`;
result.day = day;
result.lastYearDay = lastYearDay;

// 1. Stations -------------------------------------------------------------
const stations = await getAll('swob-stations/items', { properties: 'msc_id,name,data_provider,dataset_network,auto_man,province_territory' });
result.stations = {
  listed: stations.length,
  byProvider: tally(stations.map((s) => s.properties.data_provider ?? 'none')),
  byAutoMan: tally(stations.map((s) => `${s.properties.data_provider ?? 'none'} / ${s.properties.auto_man ?? 'none'}`)),
  mscByProvince: tally(stations.filter((s) => s.properties.data_provider === 'MSC').map((s) => s.properties.province_territory ?? 'none')),
};
const listedMsc = new Set(stations.filter((s) => s.properties.data_provider === 'MSC').map((s) => String(s.properties.msc_id ?? s.id)));
result.partnerStationsListed = await hits('swob-partner-stations/items', {});

// Climate stations with hourly data (for time zones) -----------------------
const cs = await getAll('climate-stations/items', { properties: 'CLIMATE_IDENTIFIER,TIMEZONE,HAS_HOURLY_DATA' });
const zoneOf = new Map(cs.map((f) => [String(f.properties.CLIMATE_IDENTIFIER), f.properties.TIMEZONE]));
result.climateStations = {
  count: cs.length,
  withHourlyData: cs.filter((f) => f.properties.HAS_HOURLY_DATA === 'Y').length,
  byZone: tally(cs.map((f) => f.properties.TIMEZONE ?? 'none')),
};

// 2. Sampled hours of yesterday (UTC) ----------------------------------------
const FIELDS = ['air_temp', 'max_air_temp_pst1hr', 'min_air_temp_pst1hr', 'avg_wnd_spd_10m_pst1hr', 'avg_wnd_dir_10m_pst1hr', 'max_wnd_spd_10m_pst1hr', 'pcpn_amt_pst1hr', 'rnfl_amt_pst1hr', 'prsnt_wx_1', 'prsnt_wx_2', 'tot_cld_amt', 'vis', 'avg_vis_pst10mts', 'cld_amt_code', 'cld_typ_1', 'snw_dpth', 'avg_snw_dpth_pst5mts'];
const MSC_PROPS = ['msc_id-value', 'date_tm-value', 'processed_date_tm', 'clim_id-value', 'data_pvdr-value', '_is-minutely_obs-value', ...FIELDS].join(',');
const hourly = [];
const delays = []; // minutes between the hour and the reading being processed
const mscReporters = new Map(); // msc_id -> clim_id
const providerTotals = {};
const notices = {};
const wxValues = { prsnt_wx_1: {}, prsnt_wx_2: {}, tot_cld_amt: {} };
const fillAll = Object.fromEntries(FIELDS.map((f) => [f, 0]));
let mscHourlyReadings = 0;

for (const h of [0, 3, 6, 9, 12, 15, 18, 21]) {
  const t = `${day}T${String(h).padStart(2, '0')}:00:00Z`;
  const dt = `${t}/${t}`;
  // everyone, provider only (no weather values are read for other providers)
  const all = await getAll('swob-realtime/items', { datetime: dt, properties: 'data_pvdr-value,msc_id-value,_is-minutely_obs-value,data_attrib_not-value' });
  const byProv = {};
  for (const f of all) {
    const p = f.properties;
    const prov = p['data_pvdr-value'] ?? 'none';
    const e = (byProv[prov] ??= { readings: 0, minutely: 0, stations: new Set() });
    e.readings++;
    if (isMinutely(p['_is-minutely_obs-value'])) e.minutely++;
    e.stations.add(p['msc_id-value']);
    const n = p['data_attrib_not-value'];
    if (n) notices[`${prov}: ${String(n).slice(0, 110)}`] = (notices[`${prov}: ${String(n).slice(0, 110)}`] ?? 0) + 1;
  }
  const provSummary = {};
  for (const [prov, e] of Object.entries(byProv)) {
    provSummary[prov] = { readings: e.readings, minutely: e.minutely, stations: e.stations.size };
    const tot = (providerTotals[prov] ??= new Set());
    for (const s of e.stations) tot.add(s);
  }
  // MSC only: the values
  const msc = await getAll('swob-realtime/items', { datetime: dt, 'data_pvdr-value': 'MSC', properties: MSC_PROPS });
  const hr = msc.filter((f) => !isMinutely(f.properties['_is-minutely_obs-value']));
  const perStation = tally(hr.map((f) => f.properties['msc_id-value']));
  const fill = Object.fromEntries(FIELDS.map((k) => [k, hr.filter((f) => filled(f.properties[k])).length]));
  for (const f of hr) {
    mscReporters.set(String(f.properties['msc_id-value']), String(f.properties['clim_id-value'] ?? ''));
    for (const k of FIELDS) if (filled(f.properties[k])) fillAll[k]++;
    for (const k of Object.keys(wxValues)) if (filled(f.properties[k])) wxValues[k][f.properties[k]] = (wxValues[k][f.properties[k]] ?? 0) + 1;
  }
  for (const f of hr) {
    const m = (Date.parse(f.properties.processed_date_tm) - Date.parse(f.properties['date_tm-value'])) / 60000;
    if (Number.isFinite(m)) delays.push(m);
  }
  mscHourlyReadings += hr.length;
  hourly.push({ hourUtc: t, byProvider: provSummary, mscReadings: msc.length, mscNonMinutely: hr.length, mscStations: Object.keys(perStation).length, readingsPerStationDistribution: tally(Object.values(perStation)), fill });
}
result.hourSamples = hourly;
result.providersSeenAcrossSamples = Object.fromEntries(Object.entries(providerTotals).map(([k, v]) => [k, v.size]));
result.noticeTexts = top(notices, 12);
result.mscFieldFillAcrossSamples = { nonMinutelyReadings: mscHourlyReadings, fill: fillAll };
delays.sort((a, b) => a - b);
const pct = (p) => +delays[Math.min(delays.length - 1, Math.floor(delays.length * p))]?.toFixed(1);
result.minutesAfterTheHourWhenProcessed = { readings: delays.length, median: pct(0.5), p90: pct(0.9), p99: pct(0.99), slowest: +delays[delays.length - 1]?.toFixed(1) };
result.weatherWordValues = Object.fromEntries(Object.entries(wxValues).map(([k, v]) => [k, top(v, 25)]));

// 3. MSC reporters against the station list and time zones -------------------
const reporters = [...mscReporters.keys()];
result.mscReporters = {
  distinctAcrossSamples: reporters.length,
  inStationList: reporters.filter((id) => listedMsc.has(id)).length,
  notInStationList: reporters.filter((id) => !listedMsc.has(id)).length,
  listedButNeverSeen: [...listedMsc].filter((id) => !mscReporters.has(id)).length,
  withClimateIdentifier: reporters.filter((id) => mscReporters.get(id)).length,
  withTimeZone: reporters.filter((id) => zoneOf.has(mscReporters.get(id))).length,
  byZone: tally(reporters.map((id) => zoneOf.get(mscReporters.get(id)) ?? 'unknown')),
};

// 4. The climate archive ---------------------------------------------------
const reporterClim = new Set(reporters.map((id) => mscReporters.get(id)).filter(Boolean));
async function archiveDay(d) {
  const rows = await getAll('climate-hourly/items', { UTC_DATE: d, properties: 'CLIMATE_IDENTIFIER,TEMP,PRECIP_AMOUNT,WIND_SPEED,WEATHER_ENG_DESC' });
  const mine = rows.filter((f) => reporterClim.has(String(f.properties.CLIMATE_IDENTIFIER)));
  const ids = new Set(mine.map((f) => String(f.properties.CLIMATE_IDENTIFIER)));
  const withTemp = new Set(mine.filter((f) => filled(f.properties.TEMP)).map((f) => String(f.properties.CLIMATE_IDENTIFIER)));
  const desc = tally(mine.map((f) => f.properties.WEATHER_ENG_DESC ?? 'null'));
  return {
    utcDate: d,
    allRecords: rows.length,
    allStations: new Set(rows.map((f) => f.properties.CLIMATE_IDENTIFIER)).size,
    recordsForMscReporters: mine.length,
    mscReportersCovered: ids.size,
    mscReportersWithTemperature: withTemp.size,
    fill: Object.fromEntries(['TEMP', 'PRECIP_AMOUNT', 'WIND_SPEED'].map((k) => [k, mine.filter((f) => filled(f.properties[k])).length])),
    weatherDescriptions: top(desc, 15),
  };
}
const latest = await get('climate-hourly/items', { limit: 1, sortby: '-UTC_DATE' });
result.archive = {
  newestRecordUtc: latest.features?.[0]?.properties?.UTC_DATE ?? null,
  mscReportersWithAClimateIdentifier: reporterClim.size,
  yesterday: await archiveDay(day),
  yearAgo: await archiveDay(lastYearDay),
};

// 5. Request behaviour -------------------------------------------------------
const secs = [...log.seconds].sort((a, b) => a - b);
result.requests = {
  total: log.requests,
  retries: log.retries,
  droppedOrFailed: log.failures,
  statuses: log.statuses,
  medianSeconds: secs[Math.floor(secs.length / 2)],
  slowestSeconds: secs[secs.length - 1],
  rateLimitHeaders: log.rateLimitHeaders,
  firstResponseHeaders: Object.fromEntries(Object.entries(log.headers ?? {}).filter(([k]) => !/^(set-cookie|authorization)$/i.test(k))),
};

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/results.json`, JSON.stringify(result, null, 2) + '\n');
console.log(`Probe done: ${log.requests} requests, ${log.retries} retries, ${log.failures.length} failures logged.`);
console.log(`Wrote ${OUT}/results.json`);
