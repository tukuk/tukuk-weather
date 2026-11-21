'use strict';
// ── TUKUK-OS GEMPA COMPLEX — USGS Earthquake Feed (FREE, no API key) ──────────
// Source: https://earthquake.usgs.gov/fdsnws/event/1/query (GeoJSON). No signup,
// no hard quota (fair-use policy), USGS refreshes about every 5 minutes. We cache
// 10 minutes → zero extra load on our server.
// The static big-event history lives inside the explanation page text only.
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { attachGuard } = require('./outbound');
const quakebank = require('./quakebank');

const http = axios.create({
  timeout: 20000,
  headers: { 'User-Agent': 'TukukOS-Gempa-Client/1.0 (+https://tukuk.org)' },
});
// Deliberately shortened from the declared 20 s: no page on this box may hold a visitor for
// twenty seconds because USGS took a moment (the guard's 15 s default is the ceiling now).
attachGuard(http, { name: 'gempa' });

const QUERY_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

const cache = new Map();
const inflight = new Map();
const TTL = 10 * 60 * 1000;
const stats = { through: 0, mirrored: 0, failed: 0, lastError: '' };

// The last feed of every region, on disk, exactly as the books and recipes modules keep theirs:
// a restart must not make the first visitor wait for USGS, and a region whose upstream call is
// down must still answer with the list it answered with yesterday.
const MIRROR_FILE = process.env.GEMPA_MIRROR_PATH || path.join(path.dirname(config.store.path), 'gempa-last.json');
const KEEP_MIRRORED = 12; // the five regions, plus room for a question invented later

function readMirror() {
  try {
    const raw = JSON.parse(fs.readFileSync(MIRROR_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeMirror(key, entry, all) {
  try {
    all[key] = entry;
    // One entry per region question; the bound is here so a caller that invents a new question
    // every time can never grow this file without limit.
    const keys = Object.keys(all);
    if (keys.length > KEEP_MIRRORED) {
      keys.sort((a, b) => String(all[a].at || '').localeCompare(String(all[b].at || '')))
        .slice(0, keys.length - KEEP_MIRRORED)
        .forEach((k) => delete all[k]);
    }
    fs.mkdirSync(path.dirname(MIRROR_FILE), { recursive: true });
    const tmp = `${MIRROR_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, MIRROR_FILE); // rename is atomic: a reader never sees half a file
    stats.mirrored++;
  } catch {
    // a failed mirror is a slow restart later, never a broken page now
  }
}

/**
 * What the mirror files a feed under: the question, without its moving window.
 *
 * The window is rebuilt every ten minutes, so a mirror keyed by the whole parameter set would
 * file a fresh copy of the same region forever and never answer for the one being asked now.
 * Dropping the two timestamps leaves the region's identity — its box, magnitude floor and limit
 * — which is exactly why yesterday's list is still the right answer to today's question.
 */
function mirrorKey(params) {
  const rest = { ...params };
  delete rest.starttime;
  delete rest.endtime;
  return JSON.stringify(rest);
}

/**
 * The feed window is rounded DOWN to the TTL boundary before it is used as a key.
 *
 * This is the difference between a cache and a decoration: a window that ends at `now` is a
 * window that never repeats, and the key is the window. Measured on this box (24 Oct 2026),
 * three page views in a row produced three distinct keys and three USGS queries — so the
 * ten-minute cache above had never served a single hit, every visitor paid the full 7–9 s
 * round-trip, and any slow upstream call became the 503 the sitemap crawler found on
 * /earthquakes. Every request inside the same ten minutes now asks the identical question and
 * shares one entry, while the data stays no older than the window this module already promised.
 */
function timeBucket(ms = TTL) {
  return new Date(Math.floor(Date.now() / ms) * ms).toISOString();
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) return { data: hit.data, stale: true };
  return { data: hit.data, stale: false };
}

function cacheSet(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + TTL });
  if (cache.size > 60) {
    let oldestKey = null; let oldest = Infinity;
    for (const [k, v] of cache) if (v.expiresAt < oldest) { oldest = v.expiresAt; oldestKey = k; }
    if (oldestKey) cache.delete(oldestKey);
  }
}

// ——— Fixed regions (slug → lat/lon box) — bbox = [minLon, minLat, maxLon, maxLat] ———
// Slugs stay Malay because they are the public URLs; the labels are English.
const REGIONS = [
  { slug: 'malaysia', name: 'Malaysia', bbox: [98, -2, 121, 8], minMag: 2.0, hours: 24 * 30, limit: 60,
    blurb: 'The earthquakes closest to Malaysia — Sabah, Sarawak, the Peninsula and the South China Sea border.' },
  { slug: 'southeast-asia', name: 'Southeast Asia', bbox: [90, -15, 148, 30], minMag: 4.5, hours: 24 * 7, limit: 60,
    blurb: 'Indonesia, the Philippines, Papua New Guinea and neighbours — the most tectonically active zone in Asia.' },
  { slug: 'japan', name: 'Japan & the Western Pacific', bbox: [125, 10, 180, 50], minMag: 4.0, hours: 24 * 7, limit: 50,
    blurb: 'The western side of the Ring of Fire: Japan, Kamchatka, Mariana and the Ryukyu Islands.' },
  { slug: 'east-pacific', name: 'Eastern Pacific & the Americas', bbox: [-180, -60, -55, 62], minMag: 5.0, hours: 24 * 7, limit: 50,
    blurb: 'The west coast of the Americas: California, Chile, Peru, Mexico and Alaska.' },
  { slug: 'world', name: 'World M4.5+', bbox: null, minMag: 4.5, hours: 24 * 7, limit: 80,
    blurb: 'Every earthquake of magnitude 4.5 or above worldwide, over the last seven days.' },
];

function findRegion(slug) {
  return REGIONS.find((r) => r.slug === String(slug || '')) || null;
}

async function usgsQuery(params) {
  const key = JSON.stringify(params);
  const hit = cacheGet(key);
  if (hit && !hit.stale) return hit.data;
  // stale-while-revalidate: a USGS feed can take ~8s; serve the old data at once
  // and re-fetch in the background so the page never 503s or waits a long time.
  if (hit && hit.stale) { fetchAndCache(key, params).catch(() => {}); return hit.data; }
  // Nothing in memory — which after a restart is every region. The disk mirror is read before
  // the network, so the first visitor of a new process gets a rendered page in milliseconds and
  // the refresh happens behind it. The entry is stored already-expired on purpose: the call
  // after this one revalidates, and the single-flight map keeps that to one USGS query.
  const mirrored = readMirror()[mirrorKey(params)];
  if (mirrored && Array.isArray(mirrored.rows) && mirrored.rows.length) {
    cache.set(key, { data: mirrored.rows, expiresAt: Date.now() });
    fetchAndCache(key, params).catch(() => {});
    return mirrored.rows;
  }
  return fetchAndCache(key, params);
}

async function fetchAndCache(key, params) {
  // Single-flight: a cold cache plus a burst of readers used to open one USGS query per
  // request, and when that upstream call timed out the page answered 503 even though a
  // retry a moment later succeeds. Callers now share one promise.
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchOnce(key, params, 0).finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

async function fetchOnce(key, params, attempt) {
  try {
    const res = await http.get(QUERY_URL, {
      params: { format: 'geojson', orderby: 'time', ...params },
    });
    const rows = (res.data && Array.isArray(res.data.features) ? res.data.features : []).map((f) => {
      const p = f.properties || {};
      const c = (f.geometry && f.geometry.coordinates) || [0, 0, 0];
      return {
        id: String(f.id || p.id || ''),
        mag: Number(p.mag) || 0,
        place: String(p.place || ''),
        time: Number(p.time) || 0,
        depth: Math.round((Number(c[2]) || 0) * 10) / 10,
        lat: Math.round(Number(c[1]) * 10000) / 10000,
        lon: Math.round(Number(c[0]) * 10000) / 10000,
        url: String(p.url || `https://earthquake.usgs.gov/earthquakes/eventpage/${f.id}`),
        tsunami: Number(p.tsunami) > 0,
        felt: Number(p.felt) || 0,
        cdi: Number(p.cdi) || 0,
        status: String(p.status || 'automatic'),
        sig: Number(p.sig) || 0,
      };
    });
    cacheSet(key, rows);
    stats.through++;
    writeMirror(mirrorKey(params), { at: new Date().toISOString(), rows }, readMirror());
    return rows;
  } catch (err) {
    stats.failed++;
    stats.lastError = String((err && err.message) || err).slice(0, 160);
    const h = cacheGet(key);
    if (h) return h.data; // stale beats an error
    // The memory is empty and the call failed: yesterday's list is still a correct answer to
    // "what happened", and it is the difference between a page and a 503 for a crawler.
    const m = readMirror()[mirrorKey(params)];
    if (m && Array.isArray(m.rows) && m.rows.length) return m.rows;
    if (attempt < 1) return fetchOnce(key, params, attempt + 1); // one retry, then give up
    throw err;
  }
}

// Query by configured region (a lat/lon box, or none for the whole world).
async function regionFeed(r) {
  // findRegion hands back null for a slug that is not in REGIONS; say so plainly
  // instead of dereferencing null and surfacing a bare TypeError at the call site.
  if (!r) throw new Error('regionFeed needs a known region');
  // Both ends of the window come from the bucket (see timeBucket): the page shows the same
  // question for the whole ten minutes, which is what lets the cache answer at all.
  const end = timeBucket();
  const params = { starttime: isoAgo(r.hours, end), endtime: end, minmagnitude: r.minMag, limit: r.limit };
  if (r.bbox) {
    const [minLon, minLat, maxLon, maxLat] = r.bbox;
    params.minlongitude = minLon; params.minlatitude = minLat;
    params.maxlongitude = maxLon; params.maxlatitude = maxLat;
  }
  // Bank first (pipeline 5: rolling 35-day USGS window rebuilt daily by quakebank-build.yml in
  // the public tukuk/tukuk-devops repo, loaded into the `quake` Meilisearch index by
  // wordbank-sync). Bank rows carry exactly the fields fetchOnce maps GeoJSON into, so a hit
  // is indistinguishable from a live answer apart from ~5 ms instead of ~8 s. A miss — or any
  // bank problem at all — falls through to the untouched USGS chain below (cache → mirror →
  // live with single-flight and retry), which stays the fallback for hours the bank lags.
  const bankRows = await quakebank.feed(params);
  if (bankRows && bankRows.length) return bankRows;
  return usgsQuery(params);
}

function isoAgo(hours, end = new Date().toISOString()) {
  return new Date(Date.parse(end) - hours * 3600 * 1000).toISOString();
}

// Summary for the hub statistic cards.
function summarise(rows) {
  if (!rows || !rows.length) return { count: 0, max: 0, latest: null, shallow: 0, felt: 0, tsunamis: 0 };
  let max = 0; let shallow = 0; let felt = 0; let tsunamis = 0;
  for (const q of rows) {
    if (q.mag > max) max = q.mag;
    if (q.depth < 35) shallow += 1;
    if (q.felt > 0) felt += 1;
    if (q.tsunami) tsunamis += 1;
  }
  return { count: rows.length, max, latest: rows[0], shallow, felt, tsunamis };
}

module.exports = { REGIONS, findRegion, regionFeed, usgsQuery, summarise, timeBucket, mirrorKey, MIRROR_FILE, readMirror, stats };
