#!/usr/bin/env node
/**
 * Load tukuk.org's earthquake bank (quake.jsonl.gz) into Meilisearch as the `quake` index.
 *
 *   node scripts/quake-load.js <quake.jsonl.gz>
 *
 * Reads from env: MEILI_HOST, MEILI_MASTER_KEY, QUAKEBANK_INDEX (default: quake).
 *
 * The rolling-window sibling of apod-load.js: rows are USGS events keyed by their USGS id
 * ("us7000...", "nc7546..." — ASCII [a-zA-Z0-9-], a legal Meilisearch document id directly),
 * so pk IS the event id and re-syncs replace revised events in place.
 *
 * Full wipe + reload every sync — deliberately, more than for the other banks: the release is
 * a snapshot of ONE rolling 35-day window, so anything older than that window is not "still
 * true", it is out of the answer set, and leaving it in would let a >35-day-old event slip
 * into a feed the app believes is windowed. Streaming like every loader regardless of size.
 */
const fs = require('fs');
const zlib = require('zlib');

const MEILI = (process.env.MEILI_HOST || 'http://127.0.0.1:7700').replace(/\/$/, '');
const KEY = process.env.MEILI_MASTER_KEY || '';
const INDEX = process.env.QUAKEBANK_INDEX || 'quake';
const FILE = process.argv[2];
const BATCH = Number(process.env.QUAKEBANK_BATCH || 1000);

if (!FILE) {
  console.error('usage: node scripts/quake-load.js <quake.jsonl.gz>');
  process.exit(1);
}
if (!KEY) {
  console.error('MEILI_MASTER_KEY is empty');
  process.exit(1);
}

function request(method, pathname, body) {
  return fetch(`${MEILI}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(async (res) => {
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  });
}

async function waitForTask(uid, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const t = await request('GET', `/tasks/${uid}`);
    if (t && (t.status === 'succeeded' || t.status === 'failed' || t.status === 'canceled')) {
      if (t.status === 'failed') throw new Error(`task ${uid} failed: ${t.error && t.error.message}`);
      return t;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`task ${uid} timed out after ${timeoutMs}ms`);
}

// One bank row -> one document. Fields are exactly what src/gempa.js fetchOnce produces;
// src/quakebank.js filters on time/mag/lat/lon and sorts on time, so those are the indexed
// attributes and nothing else needs to be.
function docFromRow(d) {
  if (!d || !/^[A-Za-z0-9_-]+$/.test(String(d.id || ''))) return null;
  if (typeof d.time !== 'number' || typeof d.mag !== 'number') return null;
  return {
    pk: String(d.id),
    id: String(d.id),
    mag: d.mag,
    place: String(d.place || ''),
    time: d.time,
    depth: Number(d.depth) || 0,
    lat: Number(d.lat) || 0,
    lon: Number(d.lon) || 0,
    url: String(d.url || `https://earthquake.usgs.gov/earthquakes/eventpage/${d.id}`),
    tsunami: !!d.tsunami,
    felt: Number(d.felt) || 0,
    cdi: Number(d.cdi) || 0,
    status: String(d.status || 'automatic'),
    sig: Number(d.sig) || 0
  };
}

async function main() {
  try {
    await request('GET', `/indexes/${INDEX}`);
  } catch (e) {
    const task = await request('POST', '/indexes', { uid: INDEX, primaryKey: 'pk' });
    await waitForTask(task.taskUid);
    console.log(`created index ${INDEX}`);
  }

  const settings = {
    searchableAttributes: ['place'],
    filterableAttributes: ['time', 'mag', 'lat', 'lon', 'depth'],
    sortableAttributes: ['time'],
    displayedAttributes: ['*']
  };
  const sTask = await request('PATCH', `/indexes/${INDEX}/settings`, settings);
  await waitForTask(sTask.taskUid);

  const del = await request('DELETE', `/indexes/${INDEX}/documents`);
  await waitForTask(del.taskUid);

  const rl = require('readline').createInterface({
    input: fs.createReadStream(FILE).pipe(zlib.createGunzip()),
    crlfDelay: Infinity
  });
  let batch = [];
  let seen = 0;
  let loaded = 0;
  let lastTask = null;
  async function flush() {
    if (!batch.length) return;
    const task = await request('POST', `/indexes/${INDEX}/documents`, batch);
    batch = [];
    lastTask = task;
  }
  for await (const line of rl) {
    if (!line.trim()) continue;
    seen++;
    let d;
    try {
      d = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const doc = docFromRow(d);
    if (!doc) continue;
    batch.push(doc);
    loaded++;
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  if (lastTask) await waitForTask(lastTask.taskUid);

  const stats = await request('GET', `/indexes/${INDEX}/stats`);
  console.log(`done: read ${seen} rows, served ${loaded} into index ${INDEX} (now ${stats.numberOfDocuments} documents)`);
}

main().catch((err) => {
  console.error('quake-load failed:', err.message);
  process.exit(1);
});
