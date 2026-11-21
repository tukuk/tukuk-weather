'use strict';
// ── TUKUK-OS AIR & OXYGEN COMPLEX — world air readings + live CO2 ─────────────
// Sources (FREE, no API key):
//   * Open-Meteo Air Quality API (CAMS/EUCCC model; us_aqi, PM2.5, PM10, O3, NO2)
//     https://air-quality-api.open-meteo.com — no sign-up, use it sparingly.
//   * NOAA Global Monitoring Laboratory — daily Mauna Loa CO2 + global annual mean
//     https://gml.noaa.gov/webdata/ccgg/trends/co2/ (public data, credit: NOAA GML)
// The same honesty contract as ISS: every payload carries source:'live' |
// 'partial' | 'last-known' | 'unavailable'. NO invented data — if a source is down,
// the page shows a rest note instead of made-up numbers.
const axios = require('axios');
const https = require('https');
const { attachGuard } = require('./outbound');

const http = axios.create({
  timeout: 20000,
  // Our VPS: the IPv6 route to gml.noaa.gov is dead (ETIMEDOUT right away); IPv4 curl works.
  // Force the IPv4 family so NOAA is always reachable.
  httpsAgent: new https.Agent({ family: 4 }),
  headers: { 'User-Agent': 'TukukOS-Air-Client/1.0 (+https://tukuk.org)' },
});
// Deliberately shortened from the declared 20 s to the guard's 15 s ceiling: the NOAA daily
// CO2 file and the open-meteo AQI call are both page-render dependencies, and this module's
// honesty contract already says a dead source shows a rest note instead of numbers — a rest
// note at 15 s beats a spinner at 20 s (src/outbound.js).
attachGuard(http, { name: 'udara' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Simple in-module cache (Map + TTL) ───────────────────────────────────
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) return { data: hit.data, stale: true };
  return { data: hit.data, stale: false };
}
function cacheSet(key, data, ttlMs) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

const AIR_TTL = 45 * 60 * 1000;        // refresh the ranking every 45 minutes
const AIR_LASTGOOD_TTL = 24 * 60 * 60 * 1000;
const CO2_TTL = 12 * 60 * 60 * 1000;   // NOAA's file updates daily: 12 hours is enough

// ── World city list (fixed lat/lon; balanced across regions) ─────────────
const CITIES = [
  // Asia
  { name: 'Delhi', country: 'India', region: 'Asia', lat: 28.61, lon: 77.21 },
  { name: 'Mumbai', country: 'India', region: 'Asia', lat: 19.08, lon: 72.88 },
  { name: 'Kolkata', country: 'India', region: 'Asia', lat: 22.57, lon: 88.36 },
  { name: 'Dhaka', country: 'Bangladesh', region: 'Asia', lat: 23.81, lon: 90.41 },
  { name: 'Lahore', country: 'Pakistan', region: 'Asia', lat: 31.55, lon: 74.34 },
  { name: 'Karachi', country: 'Pakistan', region: 'Asia', lat: 24.86, lon: 67.01 },
  { name: 'Beijing', country: 'China', region: 'Asia', lat: 39.90, lon: 116.41 },
  { name: 'Shanghai', country: 'China', region: 'Asia', lat: 31.23, lon: 121.47 },
  { name: 'Jakarta', country: 'Indonesia', region: 'Asia', lat: -6.21, lon: 106.85 },
  { name: 'Bangkok', country: 'Thailand', region: 'Asia', lat: 13.76, lon: 100.50 },
  { name: 'Hanoi', country: 'Vietnam', region: 'Asia', lat: 21.03, lon: 105.85 },
  { name: 'Manila', country: 'Philippines', region: 'Asia', lat: 14.60, lon: 120.98 },
  { name: 'Kuala Lumpur', country: 'Malaysia', region: 'Asia', lat: 3.14, lon: 101.69 },
  { name: 'Singapore', country: 'Singapore', region: 'Asia', lat: 1.35, lon: 103.82 },
  { name: 'Seoul', country: 'South Korea', region: 'Asia', lat: 37.57, lon: 126.98 },
  { name: 'Tokyo', country: 'Japan', region: 'Asia', lat: 35.68, lon: 139.69 },
  { name: 'Osaka', country: 'Japan', region: 'Asia', lat: 34.70, lon: 135.50 },
  { name: 'Taipei', country: 'Taiwan', region: 'Asia', lat: 25.03, lon: 121.57 },
  { name: 'Ulaanbaatar', country: 'Mongolia', region: 'Asia', lat: 47.89, lon: 106.91 },
  { name: 'Almaty', country: 'Kazakhstan', region: 'Asia', lat: 43.24, lon: 76.95 },
  { name: 'Dubai', country: 'UAE', region: 'Asia', lat: 25.20, lon: 55.27 },
  { name: 'Doha', country: 'Qatar', region: 'Asia', lat: 25.29, lon: 51.53 },
  { name: 'Riyadh', country: 'Saudi Arabia', region: 'Asia', lat: 24.71, lon: 46.67 },
  // Eropah
  { name: 'London', country: 'United Kingdom', region: 'Europe', lat: 51.51, lon: -0.13 },
  { name: 'Paris', country: 'France', region: 'Europe', lat: 48.86, lon: 2.35 },
  { name: 'Berlin', country: 'Germany', region: 'Europe', lat: 52.52, lon: 13.41 },
  { name: 'Madrid', country: 'Spain', region: 'Europe', lat: 40.42, lon: -3.70 },
  { name: 'Barcelona', country: 'Spain', region: 'Europe', lat: 41.39, lon: 2.16 },
  { name: 'Rome', country: 'Italy', region: 'Europe', lat: 41.90, lon: 12.50 },
  { name: 'Athens', country: 'Greece', region: 'Europe', lat: 37.98, lon: 23.73 },
  { name: 'Warsaw', country: 'Poland', region: 'Europe', lat: 52.23, lon: 21.01 },
  { name: 'Krakow', country: 'Poland', region: 'Europe', lat: 50.06, lon: 19.94 },
  { name: 'Moscow', country: 'Russia', region: 'Europe', lat: 55.76, lon: 37.62 },
  { name: 'Istanbul', country: 'Türkiye', region: 'Europe', lat: 41.01, lon: 28.98 },
  { name: 'Stockholm', country: 'Sweden', region: 'Europe', lat: 59.33, lon: 18.07 },
  { name: 'Oslo', country: 'Norway', region: 'Europe', lat: 59.91, lon: 10.75 },
  { name: 'Helsinki', country: 'Finland', region: 'Europe', lat: 60.17, lon: 24.94 },
  { name: 'Copenhagen', country: 'Denmark', region: 'Europe', lat: 55.68, lon: 12.57 },
  { name: 'Amsterdam', country: 'Netherlands', region: 'Europe', lat: 52.37, lon: 4.90 },
  { name: 'Zurich', country: 'Switzerland', region: 'Europe', lat: 47.38, lon: 8.54 },
  { name: 'Vienna', country: 'Austria', region: 'Europe', lat: 48.21, lon: 16.37 },
  { name: 'Reykjavik', country: 'Iceland', region: 'Europe', lat: 64.13, lon: -21.90 },
  { name: 'Dublin', country: 'Ireland', region: 'Europe', lat: 53.35, lon: -6.26 },
  { name: 'Lisbon', country: 'Portugal', region: 'Europe', lat: 38.72, lon: -9.14 },
  // Afrika
  { name: 'Cairo', country: 'Egypt', region: 'Africa', lat: 30.04, lon: 31.24 },
  { name: 'Lagos', country: 'Nigeria', region: 'Africa', lat: 6.52, lon: 3.38 },
  { name: 'Johannesburg', country: 'South Africa', region: 'Africa', lat: -26.20, lon: 28.05 },
  { name: 'Cape Town', country: 'South Africa', region: 'Africa', lat: -33.92, lon: 18.42 },
  { name: 'Nairobi', country: 'Kenya', region: 'Africa', lat: -1.29, lon: 36.82 },
  { name: 'Casablanca', country: 'Morocco', region: 'Africa', lat: 33.57, lon: -7.59 },
  { name: 'Accra', country: 'Ghana', region: 'Africa', lat: 5.60, lon: -0.19 },
  { name: 'Addis Ababa', country: 'Ethiopia', region: 'Africa', lat: 9.03, lon: 38.74 },
  // Amerika
  { name: 'New York', country: 'United States', region: 'Americas', lat: 40.71, lon: -74.01 },
  { name: 'Los Angeles', country: 'United States', region: 'Americas', lat: 34.05, lon: -118.24 },
  { name: 'Chicago', country: 'United States', region: 'Americas', lat: 41.88, lon: -87.63 },
  { name: 'Houston', country: 'United States', region: 'Americas', lat: 29.76, lon: -95.37 },
  { name: 'Mexico City', country: 'Mexico', region: 'Americas', lat: 19.43, lon: -99.13 },
  { name: 'Toronto', country: 'Canada', region: 'Americas', lat: 43.65, lon: -79.38 },
  { name: 'Vancouver', country: 'Canada', region: 'Americas', lat: 49.28, lon: -123.12 },
  { name: 'São Paulo', country: 'Brazil', region: 'Americas', lat: -23.55, lon: -46.63 },
  { name: 'Rio de Janeiro', country: 'Brazil', region: 'Americas', lat: -22.91, lon: -43.17 },
  { name: 'Lima', country: 'Peru', region: 'Americas', lat: -12.05, lon: -77.04 },
  { name: 'Bogotá', country: 'Colombia', region: 'Americas', lat: 4.71, lon: -74.07 },
  { name: 'Santiago', country: 'Chile', region: 'Americas', lat: -33.45, lon: -70.67 },
  { name: 'Buenos Aires', country: 'Argentina', region: 'Americas', lat: -34.60, lon: -58.38 },
  // Oceania
  { name: 'Sydney', country: 'Australia', region: 'Oceania', lat: -33.87, lon: 151.21 },
  { name: 'Melbourne', country: 'Australia', region: 'Oceania', lat: -37.81, lon: 144.96 },
  { name: 'Brisbane', country: 'Australia', region: 'Oceania', lat: -27.47, lon: 153.03 },
  { name: 'Perth', country: 'Australia', region: 'Oceania', lat: -31.95, lon: 115.86 },
  { name: 'Auckland', country: 'New Zealand', region: 'Oceania', lat: -36.85, lon: 174.76 },
  { name: 'Wellington', country: 'New Zealand', region: 'Oceania', lat: -41.29, lon: 174.78 },
];

// US AQI categories (EPA) — label + CSS class are wired in exactly one place.
function aqiCategory(v) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v <= 50) return { label: 'Good', cls: 'good' };
  if (v <= 100) return { label: 'Moderate', cls: 'moderate' };
  if (v <= 150) return { label: 'Sensitive groups', cls: 'usg' };
  if (v <= 200) return { label: 'Unhealthy', cls: 'unhealthy' };
  if (v <= 300) return { label: 'Very unhealthy', cls: 'very' };
  return { label: 'Hazardous', cls: 'hazardous' };
}

let airInFlight = null; // dedup: only one simultaneous refresh
const AIR_KEY = 'air:ranking'; // module scope — refreshAir & getAirRanking use the same key

async function fetchCityAir(c) {
  const url = 'https://air-quality-api.open-meteo.com/v1/air-quality';
  const res = await http.get(url, {
    timeout: 9000, // a tighter per-city timeout; on failure → retry, don't hang
    params: {
      latitude: c.lat, longitude: c.lon,
      current: 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide', timezone: 'UTC',
    },
  });
  const cur = res.data && res.data.current;
  if (!cur || !Number.isFinite(Number(cur.us_aqi))) throw new Error('no us_aqi for ' + c.name);
  return {
    name: c.name, country: c.country, region: c.region, lat: c.lat, lon: c.lon,
    usAqi: Number(cur.us_aqi),
    pm25: Number.isFinite(Number(cur.pm2_5)) ? Number(cur.pm2_5) : null,
    pm10: Number.isFinite(Number(cur.pm10)) ? Number(cur.pm10) : null,
    o3: Number.isFinite(Number(cur.ozone)) ? Number(cur.ozone) : null,
    no2: Number.isFinite(Number(cur.nitrogen_dioxide)) ? Number(cur.nitrogen_dioxide) : null,
    asOf: String(cur.time || ''),
  };
}

// VPS report: 6 at a time is too aggressive — Open-Meteo starts throttling after
// ±40 requests. Small chunks + a pause + one gentle retry fix coverage.
async function fetchCityAirRetry(c) {
  try { return await fetchCityAir(c); } catch (e) { await sleep(300); return await fetchCityAir(c); }
}

// Ranking for all cities → { source, asOf, rows } (rows separated by AQI).
async function getAirRanking(force) {
  if (!force) {
    const hit = cacheGet(AIR_KEY);
    if (hit) {
      if (!hit.stale) return hit.data;
      // Stale-while-revalidate: a full scrape takes ~60 seconds (50 cities × 9s timeout).
      // Visitors shouldn't pay for that — serve the old snapshot immediately,
      // run the new scan in the background; the page labels its age honestly.
      refreshAir().catch(() => {});
      return Object.assign({}, hit.data, { updating: true });
    }
    // No snapshot yet (first visit after a restart, before prewarm gets there): visitors
    // shouldn't wait for a full ~2–3 minute scrape — serve an honest 'starting'
    // state while the first scan runs in the background.
    refreshAir().catch(() => {});
    return { source: 'starting', rows: [], failedCount: 0, asOf: '', fetchedAt: Date.now() };
  }
  return refreshAir();
}

function refreshAir() {
  if (airInFlight) return airInFlight;
  airInFlight = (async () => {
    try {
      const rows = [];
      const failed = [];
      const CHUNK = 4; // Controlled request drip: 4 cities at once, 250 ms pause
      for (let i = 0; i < CITIES.length; i += CHUNK) {
        const slice = CITIES.slice(i, i + CHUNK);
        const settled = await Promise.all(slice.map(fetchCityAirRetry).map((p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }))));
        for (const s of settled) (s.ok ? rows : failed).push(s.ok ? s.r : s.e);
        await sleep(250);
      }
      if (!rows.length) throw new Error('every city failed');
      rows.sort((a, b) => a.usAqi - b.usAqi);
      const source = failed.length ? 'partial' : 'live';
      const data = { source, rows, failedCount: failed.length, asOf: rows[0] && rows[0].asOf, fetchedAt: Date.now() };
      cacheSet(AIR_KEY, data, AIR_TTL);
      cacheSet('air:last-good', data, AIR_LASTGOOD_TTL);
      return data;
    } catch (err) {
      const good = cacheGet('air:last-good');
      if (good && good.data && good.data.rows && good.data.rows.length) {
        const stale = Object.assign({}, good.data, { source: 'last-known', staleSince: good.data.fetchedAt });
        cacheSet(AIR_KEY, stale, 5 * 60 * 1000); // try again after 5 minutes
        return stale;
      }
      const empty = { source: 'unavailable', rows: [], failedCount: CITIES.length, asOf: '', fetchedAt: Date.now() };
      cacheSet(AIR_KEY, empty, 5 * 60 * 1000);
      return empty;
    } finally {
      airInFlight = null;
    }
  })();
  return airInFlight;
}

// Prewarm: after boot (12 s) and every 40 minutes — the TTL is 45 min, so the
// cache never expires while the server is up; even the first visitor doesn't wait.
// unref() so `node --test` runs can finish without waiting on the timer.
{
  const warm = setTimeout(() => { getAirRanking().catch(() => {}); }, 12000);
  if (warm.unref) warm.unref();
  const iv = setInterval(() => { getAirRanking().catch(() => {}); }, 40 * 60 * 1000);
  if (iv.unref) iv.unref();
}

// ——— Live CO2 (NOAA GML) ———
function parseNumericLine(line) {
  const f = line.trim().split(/\s+/).map(Number);
  return f.every((n) => Number.isFinite(n)) ? f : null;
}
// Find the ppm field: a value inside the plausible CO2 range (250–700), preferring decimals.
function pickPpm(fields) {
  for (const n of fields) if (n > 250 && n < 700 && n % 1 !== 0) return n;
  for (const n of fields) if (n > 250 && n < 700) return n;
  return null;
}

async function getCo2(force) {
  const key = 'co2:latest';
  if (!force) {
    const hit = cacheGet(key);
    if (hit && !hit.stale) return hit.data;
  }
  try {
    const [dailyRes, annRes] = await Promise.all([
      http.get('https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_daily_mlo.txt'),
      http.get('https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_gl.txt'),
    ]);
    const dailyLines = String(dailyRes.data).split('\n').filter((l) => l && l[0] !== '#');
    const last = parseNumericLine(dailyLines[dailyLines.length - 1] || '');
    if (!last) throw new Error('the daily CO2 file could not be read');
    const ppm = pickPpm(last);
    if (ppm == null) throw new Error('ppm field not found');
    const y = last[0], m = last[1], d = last[2];
    const annLines = String(annRes.data).split('\n').filter((l) => l && l[0] !== '#');
    const means = [];
    for (const l of annLines) {
      const f = parseNumericLine(l);
      if (f && f.length >= 2 && f[0] >= 1959 && f[1] > 250 && f[1] < 700) means.push({ year: Math.round(f[0]), v: f[1] });
    }
    if (!means.length) throw new Error('no annual means');
    means.sort((a, b) => a.year - b.year);
    const recent = means.slice(-15);
    let growth = null;
    if (means.length >= 2) {
      const a = means[means.length - 1], b = means[means.length - 2];
      if (a.year - b.year === 1) growth = Math.round((a.v - b.v) * 100) / 100;
    }
    const data = {
      source: 'live', ppm: Math.round(ppm * 100) / 100,
      date: y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
      site: 'Mauna Loa, Hawaii', growth, latestYear: means[means.length - 1].year,
      annual: recent, preIndustrial: 280, base1958: means[0].v,
      fetchedAt: Date.now(),
    };
    cacheSet(key, data, CO2_TTL);
    cacheSet('co2:last-good', data, AIR_LASTGOOD_TTL);
    return data;
  } catch (err) {
    const good = cacheGet('co2:last-good');
    if (good && good.data) return Object.assign({}, good.data, { source: 'last-known' });
    return { source: 'unavailable', rows: [], fetchedAt: Date.now() };
  }
}

// ── Rivers: flood risk from the Open-Meteo Flood API ─────────────────────────
// Source: https://flood-api.open-meteo.com — the GLOROD/GloFAS model, FREE without
// a key. river_discharge is in m³/s. We compare the latest reading against
// a year of local history → percentage + a conservative label. This is a model, not
// a real river gauge — the page must label it as an estimate.
const RIVER_TTL = 6 * 60 * 60 * 1000;
async function getRiver(lat, lon) {
  const key = `river:${Number(lat).toFixed(2)}:${Number(lon).toFixed(2)}`;
  const hit = cacheGet(key);
  if (hit && !hit.stale) return hit.data;
  try {
    const res = await http.get('https://flood-api.open-meteo.com/v1/flood', {
      params: { latitude: lat, longitude: lon, daily: 'river_discharge', past_days: 365, timezone: 'UTC' },
    });
    const d = res.data && res.data.daily;
    if (!d || !Array.isArray(d.time) || !Array.isArray(d.river_discharge)) throw new Error('no series');
    const rows = d.time.map((t, i) => ({ date: t, v: d.river_discharge[i] }))
      .filter((r) => Number.isFinite(r.v));
    if (rows.length < 30) throw new Error('series too short');
    const vals = rows.map((r) => r.v).sort((a, b) => a - b);
    const latest = rows[rows.length - 1];
    const below = vals.filter((v) => v <= latest.v).length;
    const pct = Math.round((below / vals.length) * 100);
    const recent = rows.slice(-35).map((r) => Math.round(r.v * 10) / 10);
    const data = {
      source: 'live', date: latest.date, current: Math.round(latest.v * 10) / 10,
      unit: 'm³/s', pctYear: pct, min: Math.round(vals[0] * 10) / 10,
      max: Math.round(vals[vals.length - 1] * 10) / 10, median: Math.round(vals[Math.floor(vals.length / 2)] * 10) / 10,
      series: recent, days: rows.length, fetchedAt: Date.now(),
    };
    cacheSet(key, data, RIVER_TTL);
    return data;
  } catch (err) {
    if (hit) return Object.assign({}, hit.data, { source: 'last-known' });
    return { source: 'unavailable', fetchedAt: Date.now() };
  }
}

// ── Educational curation: oxygen ────────────────────────────────────────
// Numbers are chosen conservatively & are checkable; fuzzy values are labelled "about".
const OXYGEN = [
  { h: 'The 20.9 percent number', paras: [
    'Dry air at sea level is about 78 percent nitrogen, 20.9 percent oxygen, 0.9 percent argon and a restless remainder of carbon dioxide, water vapour and traces. The oxygen share has barely moved in human history — yet every breath you take removes about one-quarter of the oxygen from the air you exhale.',
    'That 20.9 percent is a tightrope: high enough that fires spread and metabolism runs hot, low enough that the atmosphere does not simply ignite. On other worlds Mars holds a thin 0.13 percent oxygen; without that margin, complex life as we know it is impossible.',
    'The oxygen you breathe tonight was mostly made by living things — and the largest factory is not the rainforest but the ocean.',
  ] },
  { h: 'Who actually makes the air we breathe', paras: [
    'Marine phytoplankton — microscopic drifting plants — are credited with roughly half of all the oxygen produced by photosynthesis on Earth each year. The remainder comes from land plants, forests and grasses working the other half. The often-quoted claim that "the Amazon produces 20 percent of the world’s oxygen" is only part of the story: a mature rainforest consumes nearly all of what it makes through the respiration of its own tissues and soils, leaving a much smaller net gift to the atmosphere.',
    'Net oxygen — what actually accumulates — is a tiny fraction of gross production, because decay and respiration spend almost all of it back. The 20.9 percent in today’s air is not the output of this year’s gardens; it is a bank built over hundreds of millions of years, mostly from organic carbon buried in sediments before it could be eaten back.',
    'The practical lesson: the ocean matters to your next breath more than any single forest does, and protecting plankton-rich waters is protecting the air itself.',
  ] },
  { h: 'Oxygen is slowly, measurably falling', paras: [
    'Careful air-chemistry programs have tracked the oxygen share of the atmosphere declining by roughly 0.001 percent per year for decades. The cause is combustion: fossil-fuel burning consumes oxygen and adds carbon dioxide in lockstep, and the two curves are measured on the same flasks.',
    'Do the scale check honestly: the decline is far too small to ever suffocate anyone — the atmosphere holds about 1.2 million billion tonnes of air. Its importance is as a fingerprint: the oxygen drop independently confirms that the extra CO2 in the air comes from burning carbon, not from volcanoes or the ocean outgassing.',
    'So oxygen falling a hair and CO2 climbing fast are two dials on the same instrument, both reading: fossil fuels.',
  ] },
  { h: 'Deep time: when Earth breathed differently', paras: [
    'Oxygen has not been constant across Earth history. Around 3 billion years ago the atmosphere held almost none; cyanobacteria started the great oxygenation event that changed everything. In the Carboniferous period, some 300 million years ago, levels may have reached 30 to 35 percent — and the insects were enormous: Meganeura, a dragonfly relative, flew with a wingspan near 70 centimetres because its tracheal system scales with oxygen availability.',
    'Periods of very low oxygen (below about 15 percent) are hard to reconcile with big active animals at all. The rise of complex life, the shape of fire regimes, and even the size of insects have all ridden on this single gas.',
    'Today’s 20.9 percent is the setting that makes warm-blooded large brains possible — and it is a setting living things themselves tuned.',
  ] },
  { h: 'Why altitude steals your breath', paras: [
    'The oxygen share of the air stays at about 20.9 percent all the way up — what drops is pressure, so each breath carries fewer oxygen molecules. At 3,000 metres the body behaves as if it had only 14 to 15 percent available; at 5,364 metres (Everest base camp) roughly a third of sea-level oxygen per breath; above 8,000 metres — the so-called death zone — the body degrades even while resting.',
    'Acclimatisation is real physiology: within days the kidneys trigger more red blood cells, breathing deepens, and capillaries multiply — but full adaptation to extreme altitude takes months to years, and nobody fully adapts to 8,000 metres.',
    'This is also why airline cabins (pressurised to roughly 2,400 metres equivalent) make some people mildly short of breath, and why pilots of unpressurised aircraft once carried bottles — the same fact that makes training at altitude effective for athletes at sea level.',
  ] },
  { h: 'Oxygen in the ocean’s own lungs', paras: [
    'The sea has its own weather of oxygen. Surface water is rich; between about 200 and 1,000 metres many regions hold an "oxygen minimum zone" — a depth band where respiration outpaces supply. At the bottom of those zones, tiny tuna-like animals and squid squeeze into thin oxygen seams, and a few centimetre-long whale-size fish cannot survive there at all.',
    'Open ocean measurements over recent decades show these low-oxygen layers expanding — the same warming that holds less dissolved gas in surface water. It is a quiet squeeze that moves real fisheries, because fish avoid low-oxygen water the way hikers avoid thin air.',
    'Ocean oxygen, atmospheric oxygen and the carbon cycle are one system wearing three costumes.',
  ] },
];

// ── Educational curation: how living things breathe ────────────────────────
const HUMAN_BREATH = [
  { k: 'Normal respiratory rate, adult at rest', v: 'About 12 to 20 breaths per minute', note: 'A resting rate persistently above 20 is one of the quiet red flags doctors check.' },
  { k: 'Newborns', v: 'About 30 to 60 breaths per minute', note: 'Small lungs run on a faster clock; anything sustained above 60 in a newborn is taken seriously.' },
  { k: 'Tidal volume (per calm breath)', v: 'About half a litre of air', note: 'Roughly 350 ml of it reaches fresh gas zones; the rest lines the passages.' },
  { k: 'Daily air budget', v: 'About 20,000 breaths and 10,000 litres of air', note: 'You breathe about twenty thousand times a day without deciding on a single one.' },
  { k: 'Oxygen used per day', v: 'Roughly 550 litres', note: 'About a cubic foot of pure oxygen quietly converted every day of your life.' },
  { k: 'Gas exchange surface', v: 'Tennis-court scale, inside one chest', note: 'Roughly 300 million alveoli spread gas exchange over an enormous folded area.' },
  { k: 'Exhaled air, still useful', v: 'About 16 percent oxygen, 4 percent CO2', note: 'Your "waste" breath still holds enough oxygen for a rescue breath to work.' },
];

const ANIMAL_BREATH = [
  { a: 'Blue whale', rr: 'About 1 surface breath every few minutes when resting', note: 'A giant that chooses when to breathe: like all whales, breathing is conscious, not automatic.' },
  { a: 'Sperm whale', rr: 'Dives typically 30 to 45 minutes (records beyond 90)', note: 'Meters deep and minutes long — the brain runs on stored oxygen and patience.' },
  { a: 'Cuvier’s beaked whale', rr: 'Record breath-hold over three and a half hours', note: 'The longest verified hold of any air-breathing animal.' },
  { a: 'Dog', rr: 'About 10 to 30 breaths per minute at rest', note: 'Panting is not distress; it is their radiator — dogs cool by evaporating water from the airways.' },
  { a: 'Cat', rr: 'About 20 to 30 breaths per minute at rest', note: 'A resting rate above 30-40 sustained is a classic reason for a vet visit.' },
  { a: 'Horse', rr: 'About 8 to 16 breaths per minute at rest', note: 'Big lungs, slow clock; horses breathe almost exclusively through the nose.' },
  { a: 'Cow', rr: 'About 26 to 50 breaths per minute at rest', note: 'Ranges published for livestock run wide; heat pushes them high.' },
  { a: 'Rabbit', rr: 'About 30 to 60 breaths per minute', note: 'Small and watchful: their breathing speed tracks their metabolism.' },
  { a: 'Chicken', rr: 'About 15 to 30 breaths per minute at rest', note: 'Bird lungs are the efficient ones: air flows one way through them, fresh in both directions of the breath.' },
  { a: 'Mouse', rr: 'About 100 to 200 breaths per minute', note: 'Live fast, breathe fast: the tiny-mammal clock is brutal and instructive.' },
  { a: 'Human sprint', rr: 'Up to 40–60 per minute', note: 'Your resting 12–20 can multiply when muscles outbid your breath.' },
  { a: 'Elephant', rr: 'About 4 to 12 breaths per minute', note: 'The slowest large-animal rhythm among the giants.' },
];

const OTHER_WAYS = [
  { h: 'Gills: the counter-current trick', paras: [
    'Fish do not breathe water; they breathe the oxygen dissolved in it. Gills work on a physics cheat called counter-current exchange: blood flows opposite to the water, so wherever blood has picked up oxygen, it meets water still richer in it — letting fish wring out up to 80 percent of the water’s oxygen, a capture rate lungs envy. It is also why a fish suffocates in oxygen-rich but still water: no flow, no exchange.',
  ] },
  { h: 'Insects: pipes instead of blood', paras: [
    'Insects skip the delivery service. A branching network of tubes — tracheae — carries air directly to tissues through tiny body-side doors called spiracles. It is brilliant and limiting at once: it works well at high oxygen and small size, which is why the oxygen-rich Carboniferous grew dragonflies the size of hawks and why no insect ever became cow-sized. Your housefly is a prisoner of the same physics.',
  ] },
  { h: 'Skin, mouths and worms', paras: [
    'Earthworms breathe through moist skin — oxygen diffuses in, carbon dioxide out, and a dry surface is a death sentence (that is why worms surface after rain). Frogs double up: lungs plus skin plus, in some species, mouth-lining gas exchange. Sea horses and some fish even let the gut help. Nature treats a breath as an engineering brief, not a single design.',
  ] },
  { h: 'Birds: the crosswind lungs', paras: [
    'Bird lungs move air almost in one direction through them via a system of air sacs, so fresh air keeps passing over the exchange surfaces on both inhale and exhale. It is why bar-headed geese can clear the Himalaya on thin air that drops unacclimatised humans, and why a pigeon recovers from exertion far faster than a mammal its size.',
  ] },
];

const INDOOR_CO2 = [
  { v: 'About 420 ppm', t: 'Fresh outdoor air (2026 baseline)', d: 'The open-air number — everything indoors is above it.' },
  { v: '600–1,000 ppm', t: 'Normal, ventilation-lacking rooms', d: 'Typical classroom and office values; most people feel no symptoms.' },
  { v: '1,000–2,000 ppm', t: 'Stale air zone', d: 'Drowsiness, stuffiness and harder concentration are commonly reported; opening a window is the oldest fix.' },
  { v: 'Above 2,000 ppm', t: 'Headache territory', d: 'Persistent levels this high in homes and schools mean the ventilation is genuinely too little.' },
  { v: '5,000 ppm', t: 'Occupational exposure limit (8-hour)', d: 'The workplace limit that industrial hygiene standards set for a full working day — the same number exhaled breath is roughly 40,000 ppm.' },
  { v: '35,000–50,000 ppm', t: 'Dangerously high', d: 'Severe effects fast; no living space should ever reach here by accident.' },
];

const MYTHS = [
  { m: '“We should worry the air will run out of oxygen.”', f: 'The atmosphere holds enough oxygen that even a century of heavy combustion changes the percentage only in the fourth decimal place. The real concern is the carbon dioxide side of the same reaction, not suffocation.' },
  { m: '“Houseplants clean the air of a room.”', f: 'Chamber studies that inspire the claim scale badly to real rooms: you would need something like one plant per square metre of floor to match the air exchange of simply opening a window or running ventilation. Lovely plants, poor air purifiers.' },
  { m: '“The Amazon is the lungs of the Earth.”', f: 'A mature forest breathes: it respires nearly as much as it photosynthesises, so its net oxygen gift is small. The phrase fits the ocean’s plankton far better — and the forest’s real job is the carbon it stores, not the oxygen it adds.' },
  { m: '“Cracked oxygen means instant fire.”', f: 'Fires do spread dramatically as oxygen climbs — materials ignite more easily and burn hotter in a 35-percent world — but air is no switch; the flammable edge for ordinary materials sits well above normal levels.' },
];

module.exports = { CITIES, aqiCategory, getAirRanking, getCo2, getRiver, OXYGEN, HUMAN_BREATH, ANIMAL_BREATH, OTHER_WAYS, INDOOR_CO2, MYTHS };
