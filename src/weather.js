'use strict';
// ── TUKUK-OS WEATHER COMPLEX — OpenWeather API (FREE tier only) ──────────────
// Endpoints used: /data/2.5/weather (current), /data/2.5/forecast (5 days/3h),
// /data/2.5/air_pollution (+ /forecast), /geo/1.0/direct (geocoding), and the map
// tiles /map/{layer}/{z}/{x}/{y}.png?appid. History + OneCall = paid → avoided.
// Quota guard: more than one 429 → 15-minute breaker; daily call count is capped by
// config.weather.dailyBudget — over budget we only serve cache (stale).
const axios = require('axios');
const config = require('./config');

const http = axios.create({
  timeout: 10000,
  headers: { 'User-Agent': 'TukukOS-Weather-Client/1.0 (+https://tukuk.org)' },
});

const cache = new Map();
const DEFAULT_TTL = 45 * 60 * 1000;

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) return { data: item.data, stale: true };
  return { data: item.data, stale: false };
}

function setCache(key, data, ttlMs = DEFAULT_TTL) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  if (cache.size > 400) {
    // Drop the entries with the OLDEST EXPIRY so popular cities stay warm.
    let oldestKey = null; let oldest = Infinity;
    for (const [k, v] of cache) if (v.expiresAt < oldest) { oldest = v.expiresAt; oldestKey = k; }
    if (oldestKey) cache.delete(oldestKey);
  }
}

// ——— Daily budget call count (UTC) + circuit breaker ———
let callDay = '';
let callCount = 0;
let breakerUntil = 0;

function budgetLeft() {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== callDay) { callDay = day; callCount = 0; }
  return Math.max(0, (config.weather.dailyBudget || 950) - callCount);
}

class WeatherDownError extends Error {}

async function owGet(pathname, params) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== callDay) { callDay = day; callCount = 0; }
  if (Date.now() < breakerUntil) throw new WeatherDownError('OpenWeather circuit breaker is active');
  if (callCount >= (config.weather.dailyBudget || 950)) throw new WeatherDownError('Daily API budget exhausted');
  callCount += 1;
  const res = await http.get(`${config.weather.baseUrl}${pathname}`, {
    params: { ...params, appid: config.weather.apiKey, units: 'metric' },
  });
  return res.data;
}

function markBreaker(err) {
  const status = err && err.response && err.response.status;
  // 429 = rate limit; 401/403 = key not allowed on this endpoint → back off briefly
  if (status === 429 || status === 401 || status === 403) {
    breakerUntil = Date.now() + 15 * 60 * 1000;
  }
}

// ——— Fixed city data (predictable slugs + link hub) ———
// [slug, name, cc, country, lat, lon, featured(0/1)]
const CITY_ROWS = [
  // Malaysia — every state capital + main cities (Serian = home town ✦)
  ['serian', 'Serian', 'MY', 'Malaysia', 1.1333, 110.5667, 1],
  ['kuching', 'Kuching', 'MY', 'Malaysia', 1.58, 110.31, 1],
  ['sibu', 'Sibu', 'MY', 'Malaysia', 5.18, 111.82, 0],
  ['miri', 'Miri', 'MY', 'Malaysia', 4.42, 113.98, 0],
  ['sarikei', 'Sarikei', 'MY', 'Malaysia', 2.1, 111.52, 0],
  ['betong', 'Betong', 'MY', 'Malaysia', 2.5, 111.75, 0],
  ['limbang', 'Limbang', 'MY', 'Malaysia', 4.75, 115.0, 0],
  ['kota-kinabalu', 'Kota Kinabalu', 'MY', 'Malaysia', 5.975, 116.072, 1],
  ['sandakan', 'Sandakan', 'MY', 'Malaysia', 5.84, 117.9, 0],
  ['tawau', 'Tawau', 'MY', 'Malaysia', 4.25, 117.89, 0],
  ['labuan', 'Labuan', 'MY', 'Malaysia', 5.28, 115.24, 0],
  ['kuala-lumpur', 'Kuala Lumpur', 'MY', 'Malaysia', 3.139, 101.6869, 1],
  ['putrajaya', 'Putrajaya', 'MY', 'Malaysia', 2.925, 101.68, 0],
  ['shah-alam', 'Shah Alam', 'MY', 'Malaysia', 3.073, 101.5185, 0],
  ['johor-bahru', 'Johor Bahru', 'MY', 'Malaysia', 1.4927, 103.7414, 1],
  ['penang', 'George Town', 'MY', 'Malaysia', 5.414, 100.329, 1],
  ['ipoh', 'Ipoh', 'MY', 'Malaysia', 4.5975, 101.0901, 0],
  ['melaka', 'Melaka', 'MY', 'Malaysia', 2.196, 102.248, 0],
  ['kuantan', 'Kuantan', 'MY', 'Malaysia', 3.806, 103.328, 0],
  ['kota-bharu', 'Kota Bharu', 'MY', 'Malaysia', 6.125, 102.238, 0],
  ['kuala-terengganu', 'Kuala Terengganu', 'MY', 'Malaysia', 5.33, 103.14, 0],
  ['alor-setar', 'Alor Setar', 'MY', 'Malaysia', 6.117, 100.368, 0],
  ['langkawi', 'Langkawi', 'MY', 'Malaysia', 6.35, 99.8, 0],
  ['taiping', 'Taiping', 'MY', 'Malaysia', 4.85, 100.74, 0],
  // Asia
  ['singapore', 'Singapore', 'SG', 'Singapore', 1.2897, 103.8501, 1],
  ['jakarta', 'Jakarta', 'ID', 'Indonesia', -6.2088, 106.8456, 1],
  ['bandung', 'Bandung', 'ID', 'Indonesia', -6.9175, 107.6191, 0],
  ['surabaya', 'Surabaya', 'ID', 'Indonesia', -7.2575, 112.7521, 0],
  ['denpasar', 'Denpasar', 'ID', 'Indonesia', -8.6705, 115.2126, 0],
  ['manila', 'Manila', 'PH', 'Philippines', 14.5995, 120.9842, 1],
  ['cebu', 'Cebu City', 'PH', 'Philippines', 10.3157, 123.8854, 0],
  ['bangkok', 'Bangkok', 'TH', 'Thailand', 13.7563, 100.5018, 1],
  ['chiang-mai', 'Chiang Mai', 'TH', 'Thailand', 18.7883, 98.9853, 0],
  ['hanoi', 'Hanoi', 'VN', 'Vietnam', 21.0329, 105.854, 0],
  ['ho-chi-minh-city', 'Ho Chi Minh City', 'VN', 'Vietnam', 10.8231, 106.63, 0],
  ['phnom-penh', 'Phnom Penh', 'KH', 'Cambodia', 11.5564, 104.9282, 0],
  ['vientiane', 'Vientiane', 'LA', 'Laos', 17.9667, 102.6, 0],
  ['yangon', 'Yangon', 'MM', 'Myanmar', 16.8667, 96.1833, 0],
  ['tokyo', 'Tokyo', 'JP', 'Japan', 35.6895, 139.6917, 1],
  ['osaka', 'Osaka', 'JP', 'Japan', 34.6937, 135.5023, 0],
  ['seoul', 'Seoul', 'KR', 'South Korea', 37.5665, 126.978, 1],
  ['taipei', 'Taipei', 'TW', 'Taiwan', 25.033, 121.5654, 0],
  ['hong-kong', 'Hong Kong', 'HK', 'Hong Kong', 22.3193, 114.1694, 0],
  ['shanghai', 'Shanghai', 'CN', 'China', 31.2304, 121.4737, 1],
  ['beijing', 'Beijing', 'CN', 'China', 39.9042, 116.4074, 0],
  ['new-delhi', 'New Delhi', 'IN', 'India', 28.6139, 77.209, 1],
  ['mumbai', 'Mumbai', 'IN', 'India', 19.076, 72.8777, 1],
  ['karachi', 'Karachi', 'PK', 'Pakistan', 24.8607, 67.0011, 0],
  ['dhaka', 'Dhaka', 'BD', 'Bangladesh', 23.8103, 90.4125, 0],
  ['colombo', 'Colombo', 'LK', 'Sri Lanka', 6.9271, 79.8612, 0],
  ['kathmandu', 'Kathmandu', 'NP', 'Nepal', 27.7172, 85.324, 0],
  // Middle East & Egypt
  ['dubai', 'Dubai', 'AE', 'United Arab Emirates', 25.2048, 55.2708, 1],
  ['abu-dhabi', 'Abu Dhabi', 'AE', 'United Arab Emirates', 24.4539, 54.3773, 0],
  ['doha', 'Doha', 'QA', 'Qatar', 25.2854, 51.531, 0],
  ['riyadh', 'Riyadh', 'SA', 'Saudi Arabia', 24.7136, 46.6753, 0],
  ['jeddah', 'Jeddah', 'SA', 'Saudi Arabia', 21.4858, 39.1925, 0],
  ['makkah', 'Makkah', 'SA', 'Saudi Arabia', 21.4225, 39.8262, 0],
  ['madinah', 'Madinah', 'SA', 'Saudi Arabia', 24.5247, 39.5692, 0],
  ['istanbul', 'Istanbul', 'TR', 'Turkey', 41.0082, 28.9784, 1],
  ['cairo', 'Cairo', 'EG', 'Egypt', 30.0444, 31.2357, 1],
  ['amman', 'Amman', 'JO', 'Jordan', 31.9539, 35.9106, 0],
  ['beirut', 'Beirut', 'LB', 'Lebanon', 33.8938, 35.5018, 0],
  ['baghdad', 'Baghdad', 'IQ', 'Iraq', 33.3152, 44.3661, 0],
  ['tehran', 'Tehran', 'IR', 'Iran', 35.6892, 51.389, 0],
  // Europe
  ['london', 'London', 'GB', 'United Kingdom', 51.5074, -0.1278, 1],
  ['manchester', 'Manchester', 'GB', 'United Kingdom', 53.4808, -2.2426, 0],
  ['paris', 'Paris', 'FR', 'France', 48.8566, 2.3522, 1],
  ['berlin', 'Berlin', 'DE', 'Germany', 52.52, 13.405, 1],
  ['munich', 'Munich', 'DE', 'Germany', 48.1351, 11.582, 0],
  ['madrid', 'Madrid', 'ES', 'Spain', 40.4168, -3.7038, 0],
  ['barcelona', 'Barcelona', 'ES', 'Spain', 41.3874, 2.1686, 0],
  ['rome', 'Rome', 'IT', 'Italy', 41.9028, 12.4964, 0],
  ['amsterdam', 'Amsterdam', 'NL', 'Netherlands', 52.3676, 4.9041, 0],
  ['vienna', 'Vienna', 'AT', 'Austria', 48.2082, 16.3738, 0],
  ['zurich', 'Zurich', 'CH', 'Switzerland', 47.3769, 8.5417, 0],
  ['moscow', 'Moscow', 'RU', 'Russia', 55.7558, 37.6173, 1],
  ['kyiv', 'Kyiv', 'UA', 'Ukraine', 50.4501, 30.5234, 0],
  ['warsaw', 'Warsaw', 'PL', 'Poland', 52.2297, 21.0122, 0],
  ['prague', 'Prague', 'CZ', 'Czech', 50.0755, 14.4378, 0],
  ['budapest', 'Budapest', 'HU', 'Hungary', 47.4979, 19.0402, 0],
  ['stockholm', 'Stockholm', 'SE', 'Sweden', 59.3293, 18.0686, 0],
  ['oslo', 'Oslo', 'NO', 'Norway', 59.9139, 10.7522, 0],
  ['copenhagen', 'Copenhagen', 'DK', 'Denmark', 55.6761, 12.5683, 0],
  ['helsinki', 'Helsinki', 'FI', 'Finland', 60.1699, 24.9384, 0],
  ['dublin', 'Dublin', 'IE', 'Ireland', 53.3498, -6.2603, 0],
  ['lisbon', 'Lisbon', 'PT', 'Portugal', 38.7223, -9.1393, 0],
  ['athens', 'Athens', 'GR', 'Greece', 37.9838, 23.7275, 0],
  ['belgrade', 'Belgrade', 'RS', 'Serbia', 44.7866, 20.4489, 0],
  // Americas
  ['new-york', 'New York', 'US', 'United States', 40.7128, -74.006, 1],
  ['los-angeles', 'Los Angeles', 'US', 'United States', 34.0522, -118.2437, 1],
  ['chicago', 'Chicago', 'US', 'United States', 41.8781, -87.6298, 0],
  ['houston', 'Houston', 'US', 'United States', 29.7604, -95.3698, 0],
  ['miami', 'Miami', 'US', 'United States', 25.7617, -80.1918, 0],
  ['washington', 'Washington DC', 'US', 'United States', 38.9072, -77.0369, 0],
  ['honolulu', 'Honolulu', 'US', 'United States', 21.3069, -157.8583, 0],
  ['toronto', 'Toronto', 'CA', 'Canada', 43.6532, -79.3832, 1],
  ['vancouver', 'Vancouver', 'CA', 'Canada', 49.2827, -123.1207, 0],
  ['montreal', 'Montreal', 'CA', 'Canada', 45.5017, -73.5673, 0],
  ['mexico-city', 'Mexico City', 'MX', 'Mexico', 19.4326, -99.1332, 1],
  ['cancun', 'Cancun', 'MX', 'Mexico', 21.1619, -86.8515, 0],
  ['havana', 'Havana', 'CU', 'Cuba', 23.1136, -82.3666, 0],
  ['kingston', 'Kingston', 'JM', 'Jamaica', 17.977, -76.783, 0],
  ['bogota', 'Bogota', 'CO', 'Colombia', 4.711, -74.0721, 0],
  ['lima', 'Lima', 'PE', 'Peru', -12.0464, -77.0428, 0],
  ['caracas', 'Caracas', 'VE', 'Venezuela', 10.4806, -66.9036, 0],
  ['sao-paulo', 'Sao Paulo', 'BR', 'Brazil', -23.5505, -46.6333, 1],
  ['rio-de-janeiro', 'Rio de Janeiro', 'BR', 'Brazil', -22.9068, -43.1729, 1],
  ['brasilia', 'Brasilia', 'BR', 'Brazil', -15.7942, -47.8822, 0],
  ['buenos-aires', 'Buenos Aires', 'AR', 'Argentina', -34.6037, -58.3816, 0],
  ['santiago', 'Santiago', 'CL', 'Chile', -33.4489, -70.6693, 0],
  ['quito', 'Quito', 'EC', 'Ecuador', -0.1807, -78.4678, 0],
  ['la-paz', 'La Paz', 'BO', 'Bolivia', -16.4897, -68.1193, 0],
  // Africa
  ['lagos', 'Lagos', 'NG', 'Nigeria', 6.5244, 3.3792, 1],
  ['abuja', 'Abuja', 'NG', 'Nigeria', 9.0765, 7.3986, 0],
  ['nairobi', 'Nairobi', 'KE', 'Kenya', -1.2921, 36.8219, 1],
  ['addis-ababa', 'Addis Ababa', 'ET', 'Ethiopia', 9.02, 38.7469, 0],
  ['dar-es-salaam', 'Dar es Salaam', 'TZ', 'Tanzania', -6.7924, 39.2083, 0],
  ['kampala', 'Kampala', 'UG', 'Uganda', 0.3476, 32.5825, 0],
  ['accra', 'Accra', 'GH', 'Ghana', 5.6037, -0.187, 0],
  ['dakar', 'Dakar', 'SN', 'Senegal', 14.7167, -17.4677, 0],
  ['casablanca', 'Casablanca', 'MA', 'Morocco', 33.5731, -7.5898, 0],
  ['algiers', 'Algiers', 'DZ', 'Algeria', 36.7538, 3.0588, 0],
  ['tunis', 'Tunis', 'TN', 'Tunisia', 36.8065, 10.1815, 0],
  ['johannesburg', 'Johannesburg', 'ZA', 'South Africa', -26.2041, 28.0473, 1],
  ['cape-town', 'Cape Town', 'ZA', 'South Africa', -33.9249, 18.4241, 0],
  ['durban', 'Durban', 'ZA', 'South Africa', -29.8587, 31.0218, 0],
  ['maputo', 'Maputo', 'MZ', 'Mozambique', -25.9653, 32.5892, 0],
  ['antananarivo', 'Antananarivo', 'MG', 'Madagascar', -18.8792, 47.5079, 0],
  ['luanda', 'Luanda', 'AO', 'Angola', -8.839, 13.2894, 0],
  // Oceania & Pasifik
  ['sydney', 'Sydney', 'AU', 'Australia', -33.8688, 151.2093, 1],
  ['melbourne', 'Melbourne', 'AU', 'Australia', -37.8136, 144.9631, 1],
  ['brisbane', 'Brisbane', 'AU', 'Australia', -27.4698, 153.0251, 0],
  ['perth', 'Perth', 'AU', 'Australia', -31.9505, 115.8605, 0],
  ['adelaide', 'Adelaide', 'AU', 'Australia', -34.9285, 138.6007, 0],
  ['darwin', 'Darwin', 'AU', 'Australia', -12.4634, 130.8456, 0],
  ['auckland', 'Auckland', 'NZ', 'New Zealand', -36.8485, 174.7633, 1],
  ['wellington', 'Wellington', 'NZ', 'New Zealand', -41.2866, 174.7756, 0],
  ['christchurch', 'Christchurch', 'NZ', 'New Zealand', -43.5321, 172.6362, 0],
  ['nadi', 'Nadi', 'FJ', 'Fiji', -17.7765, 177.9661, 0],
  ['suva', 'Suva', 'FJ', 'Fiji', -18.1416, 178.4419, 0],
  ['port-moresby', 'Port Moresby', 'PG', 'Papua New Guinea', -9.4438, 147.1803, 0],
  ['honiara', 'Honiara', 'SB', 'Solomon Islands', -9.4333, 159.95, 0],
];

function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const CITIES = CITY_ROWS.map(([slug, name, cc, country, lat, lon, featured]) => ({
  slug: slugify(slug), name, cc, country, lat, lon, featured: featured === 1,
}));
const CITY_BY_SLUG = new Map(CITIES.map((c) => [c.slug, c]));

function findCity(slug) {
  return CITY_BY_SLUG.get(slugify(slug)) || null;
}

function featuredCities() {
  return CITIES.filter((c) => c.featured);
}

// Geocoding — any city name in the world → a new page. Cached 30 days.
async function geocode(query) {
  const key = `geo:${slugify(query)}`;
  const hit = getCache(key);
  if (hit && !hit.stale) return hit.data;
  try {
    const data = await owGet('/geo/1.0/direct', { q: String(query).slice(0, 80), limit: 1 });
    const r = Array.isArray(data) ? data[0] : null;
    if (!r) return hit ? hit.data : null;
    const city = {
      slug: slugify(r.name || query), name: r.name || String(query).slice(0, 60),
      cc: r.country || '', country: r.country || '', lat: r.lat, lon: r.lon, featured: false,
      admin1: Array.isArray(r.state) ? r.state.join(', ') : '',
    };
    setCache(key, city, 30 * 24 * 60 * 60 * 1000);
    return city;
  } catch (err) {
    markBreaker(err);
    return hit ? hit.data : null; // stale is better than nothing
  }
}

// A city SLUG may be an earlier geocoded name — keep the geocode results that
// already succeeded so /cuaca/<slug> stays fast and does not waste API calls.
const geoSlugCache = new Map();
async function resolveCity(slug) {
  const known = findCity(slug);
  if (known) return known;
  const s = slugify(slug);
  if (geoSlugCache.has(s)) return geoSlugCache.get(s);
  const city = await geocode(s.replace(/-/g, ' '));
  if (city) {
    geoSlugCache.set(s, city);
    if (geoSlugCache.size > 500) geoSlugCache.delete(geoSlugCache.keys().next().value);
  }
  return city;
}

async function getCurrent(city) {
  const key = `cur:${city.slug}`;
  const hit = getCache(key);
  if (hit && !hit.stale) return hit.data;
  try {
    const data = await owGet('/data/2.5/weather', { lat: city.lat, lon: city.lon });
    setCache(key, data, 45 * 60 * 1000);
    return data;
  } catch (err) {
    markBreaker(err);
    if (hit) return hit.data;
    throw err;
  }
}

async function getForecast(city) {
  const key = `fc:${city.slug}`;
  const hit = getCache(key);
  if (hit && !hit.stale) return hit.data;
  try {
    const data = await owGet('/data/2.5/forecast', { lat: city.lat, lon: city.lon, cnt: 40 });
    setCache(key, data, 60 * 60 * 1000);
    return data;
  } catch (err) {
    markBreaker(err);
    if (hit) return hit.data;
    throw err;
  }
}

async function getAir(city) {
  const key = `air:${city.slug}`;
  const hit = getCache(key);
  if (hit && !hit.stale) return hit.data;
  try {
    const data = await owGet('/data/2.5/air_pollution', { lat: city.lat, lon: city.lon });
    setCache(key, data, 60 * 60 * 1000);
    return data;
  } catch (err) {
    markBreaker(err);
    if (hit) return hit.data;
    throw err;
  }
}

async function getAirForecast(city) {
  const key = `airfc:${city.slug}`;
  const hit = getCache(key);
  if (hit && !hit.stale) return hit.data;
  try {
    const data = await owGet('/data/2.5/air_pollution/forecast', { lat: city.lat, lon: city.lon });
    setCache(key, data, 12 * 60 * 60 * 1000);
    return data;
  } catch (err) {
    markBreaker(err);
    if (hit) return hit.data;
    throw err;
  }
}

// Featured-city snapshot for the hub + extremes pages (one hour; parallel load).
let snapshotCache = null;
let snapshotAt = 0;
async function getFeaturedSnapshot() {
  if (snapshotCache && Date.now() - snapshotAt < 60 * 60 * 1000) return snapshotCache;
  const list = await Promise.all(featuredCities().map(async (city) => {
    try {
      const cur = await getCurrent(city);
      return { city, cur };
    } catch {
      return null;
    }
  }));
  const ok = list.filter(Boolean);
  if (ok.length >= 6) { snapshotCache = ok; snapshotAt = Date.now(); }
  return snapshotCache || ok;
}

// ——— OpenWeather condition codes → English label + emoji (for the /cuaca/kod page) ———
// [id, apiText, meaning, emoji]
const OW_CODE_ROWS = [
  [200, 'thunderstorm with light rain', 'thunder and lightning with a light rain shower — the most common tropical storm shape', '\u26C8\uFE0F'],
  [201, 'thunderstorm with rain', 'thunderstorm with moderate rain; visibility drops while it passes', '\u26C8\uFE0F'],
  [202, 'thunderstorm with heavy rain', 'strong thunderstorm with downpours — flash-flood conditions', '\u26C8\uFE0F'],
  [210, 'light thunderstorm', 'isolated, short-lived lightning with little rain', '\u26C8\uFE0F'],
  [211, 'thunderstorm', 'general thunderstorm; stay off open ground and away from water', '\u26C8\uFE0F'],
  [212, 'heavy thunderstorm', 'severe thunderstorm — intense rain, frequent lightning, gusty outflows', '\u26C8\uFE0F'],
  [221, 'ragged thunderstorm', 'sporadic, hard-to-forecast lightning with irregular rain', '\u26C8\uFE0F'],
  [230, 'thunderstorm with light drizzle', 'lightning with a fine mist of rain', '\u26C8\uFE0F'],
  [231, 'thunderstorm with drizzle', 'thunderstorm with drizzle; roads get slick slowly', '\u26C8\uFE0F'],
  [232, 'thunderstorm with heavy drizzle', 'thunderstorm with dense drizzle — wet, poor visibility', '\u26C8\uFE0F'],
  [300, 'light intensity drizzle', 'very fine drops under 0.5 mm; light but persistent', '\uD83C\uDF26\uFE0F'],
  [301, 'drizzle', 'widespread fine droplets; an umbrella helps more than a raincoat', '\uD83C\uDF26\uFE0F'],
  [302, 'heavy intensity drizzle', 'dense drizzle that soaks through clothing', '\uD83C\uDF26\uFE0F'],
  [310, 'light intensity shower rain', 'brief light shower — starts and stops quickly', '\uD83C\uDF27\uFE0F'],
  [311, 'shower rain', 'moderate shower with clear breaks between cells', '\uD83C\uDF27\uFE0F'],
  [312, 'heavy intensity shower rain', 'intense short shower, often with gusts', '\uD83C\uDF27\uFE0F'],
  [313, 'shower rain and thunder', 'shower with thunder but little lightning', '\u26C8\uFE0F'],
  [314, 'shower rain and heavy thunder', 'heavy shower with thunder — strongest of the 3xx group', '\u26C8\uFE0F'],
  [321, 'shower snow', 'shower of snowflakes rather than rain', '\uD83C\uDF28\uFE0F'],
  [500, 'light rain', 'steady light rain, drops over 0.5 mm', '\uD83C\uDF27\uFE0F'],
  [501, 'moderate rain', 'steady moderate rain; reduced visibility on highways', '\uD83C\uDF27\uFE0F'],
  [502, 'heavy intensity rain', 'heavy continuous rain — the usual cause of urban flooding', '\uD83C\uDF27\uFE0F'],
  [503, 'very heavy rain', 'very heavy rain, often 30 mm/h or more', '\uD83C\uDF27\uFE0F'],
  [504, 'extreme rain', 'extreme rainfall rate; drainage cannot keep up', '\uD83C\uDF27\uFE0F'],
  [511, 'freezing rain', 'rain that freezes on contact — glazed ice on roads and wires', '\u2744\uFE0F'],
  [520, 'light intensity shower rain', 'isolated light shower; the classic tropical afternoon spot', '\uD83C\uDF27\uFE0F'],
  [521, 'shower rain', 'isolated moderate shower of short duration', '\uD83C\uDF27\uFE0F'],
  [522, 'shower rain with hail', 'shower carrying soft graupel or hail pellets', '\uD83C\uDF27\uFE0F'],
  [531, 'complex shower rain', 'irregular shower pattern from several cells', '\uD83C\uDF27\uFE0F'],
  [600, 'light snow', 'few snowflakes; little accumulation', '\uD83C\uDF28\uFE0F'],
  [601, 'snow', 'moderate, steady snowfall', '\uD83C\uDF28\uFE0F'],
  [602, 'heavy snow', 'heavy snowfall — travel disruption likely', '\uD83C\uDF28\uFE0F'],
  [611, 'sleet', 'mixed rain and snow pellets', '\uD83C\uDF28\uFE0F'],
  [612, 'light shower sleet', 'brief light sleet shower', '\uD83C\uDF28\uFE0F'],
  [613, 'shower sleet', 'sleet shower between clearer spells', '\uD83C\uDF28\uFE0F'],
  [616, 'rain and snow mixed', 'rain with melting snowflakes — slippery, not deep', '\uD83C\uDF28\uFE0F'],
  [620, 'light shower snow', 'light snow shower', '\uD83C\uDF28\uFE0F'],
  [621, 'shower snow', 'moderate snow shower', '\uD83C\uDF28\uFE0F'],
  [622, 'heavy shower snow', 'heavy snow shower, near-whiteout possible', '\uD83C\uDF28\uFE0F'],
  [701, 'mist', 'fine water droplets; visibility 1–2 km, milder than fog', '\uD83C\uDF2B\uFE0F'],
  [711, 'smoke', 'wildfire or burning waste — the smell is the warning', '\uD83D\uDEA1'],
  [721, 'haze', 'dry particles cut visibility; the seasonal cross-border smoke signature', '\uD83C\uDF2B\uFE0F'],
  [731, 'sand/dust whirls', 'dust devils and blowing sand on dry ground', '\uD83C\uDF2A\uFE0F'],
  [741, 'fog', 'visibility below 1 km — the most dangerous code for drivers', '\uD83C\uDF2B\uFE0F'],
  [751, 'sand', 'airborne sand from deserts or dry river beds', '\uD83C\uDFDC\uFE0F'],
  [761, 'dust', 'fine dust raised by wind or distant sources', '\uD83C\uDFDC\uFE0F'],
  [762, 'volcanic ash', 'ash from an erupting volcano — hazardous to lungs and engines', '\uD83C\uDF0B'],
  [771, 'squalls', 'sudden violent wind shifts, usually ahead of a storm', '\uD83D\uDCA8'],
  [781, 'tornado', 'tornado or waterspout reported', '\uD83C\uDF00'],
  [800, 'clear sky', 'clear — warmest nights, coldest dawns, no cloud insulation', '\u2600\uFE0F'],
  [801, 'few clouds', 'under 20% cloud cover — mostly sunny', '\uD83C\uDF24\uFE0F'],
  [802, 'scattered clouds', '20–50% cloud cover — broken sun, fair-weather cumulus', '\u26C5\uFE0F'],
  [803, 'broken clouds', '50–85% cloud cover — the sun is rarely unobstructed', '\u26C5\uFE0F'],
  [804, 'overcast clouds', 'full cloud deck — grey sky, mild temperatures day and night', '\u2601\uFE0F'],
];
const OW_CODES = OW_CODE_ROWS.map(([id, en, meaning, emoji]) => ({ id, en, meaning, emoji }));
const CODE_BY_ID = new Map(OW_CODES.map((c) => [c.id, c]));

/** describe(500) → { label: 'Light rain', meaning: '…', emoji: '🌧️' } */
function describe(codeId, isNight) {
  const c = CODE_BY_ID.get(Number(codeId)) || null;
  if (!c) return { label: 'Variable sky', meaning: 'conditions are changing', emoji: '\uD83C\uDF21\uFE0F' };
  let emoji = c.emoji;
  if (c.id === 800) emoji = isNight ? '\uD83C\uDF19' : '\u2600\uFE0F';
  if (c.id === 801 || c.id === 802) emoji = isNight ? '\uD83C\uDF19' : emoji;
  const label = c.en.charAt(0).toUpperCase() + c.en.slice(1);
  return { label, meaning: c.meaning, emoji };
}

// Beaufort wind scale (0–12) — for the /cuaca/angin page + wind speed labels.
const BEAUFORT = [
  [0, '< 1', 'Calm', 'Smoke rises vertically; leaves do not stir'],
  [1, '1–5', 'Light air', 'Wind direction shown only by smoke drift'],
  [2, '6–11', 'Light breeze', 'Leaves and small twigs in constant motion'],
  [3, '12–19', 'Gentle breeze', 'Small branches move; flags extend'],
  [4, '20–28', 'Moderate breeze', 'Dust and loose paper rise; thin branches bend'],
  [5, '29–38', 'Fresh breeze', 'Small trees sway; whitecaps form on waves'],
  [6, '39–49', 'Strong breeze', 'Large branches move; walking an umbrella is hard'],
  [7, '50–61', 'Near gale', 'Whole trees sway; walking into the wind is difficult'],
  [8, '62–74', 'Gale', 'Twigs break off; roof tiles and cladding start to lift'],
  [9, '75–88', 'Strong gale', 'Trees uprooted; moderate structural damage'],
  [10, '89–102', 'Storm', 'Widespread damage; trees snapped or toppled'],
  [11, '103–112', 'Violent storm', 'Extensive damage across built-up areas'],
  [12, '> 112', 'Hurricane force', 'Total destruction; exceptional sea waves'],
];

function beaufort(kmh) {
  const v = Number(kmh) || 0;
  for (const b of BEAUFORT) {
    const range = b[1].replace('>', '').split('\u2013').map((x) => parseInt(x, 10));
    const lo = Number.isFinite(range[0]) ? range[0] : 0;
    const hi = Number.isFinite(range[1]) ? range[1] : Infinity;
    if (b[0] === 0 && v <= 1) return b;
    if (v >= lo && v <= hi && b[0] !== 0) return b;
  }
  return BEAUFORT[12];
}

// OpenWeather AQI bands (1–5) — English health guidance.
const AQI_BANDS = [
  { n: 1, label: 'Good', color: '#2ecc71', advice: 'Clean air — fine for every outdoor activity, including exercise and running.' },
  { n: 2, label: 'Fair', color: '#a2d94e', advice: 'Acceptable. Very sensitive people (asthma, heart conditions) may notice mild irritation.' },
  { n: 3, label: 'Unhealthy for sensitive groups', color: '#f1c40f', advice: 'People with asthma or heart conditions, children and older adults should cut back long outdoor exertion.' },
  { n: 4, label: 'Unhealthy', color: '#e67e22', advice: 'Everyone should limit time outdoors; wear PM2.5 protection if you must go out.' },
  { n: 5, label: 'Very unhealthy', color: '#e74c3c', advice: 'Avoid outdoor activity. Keep windows shut and run an air purifier if you have one.' },
];

function aqiBand(n) {
  return AQI_BANDS[Math.min(Math.max((Number(n) || 1) - 1, 0), 4)];
}

// Daily conditions → get-ready advice (unique to each city page).
function cityAdvice(cur, air) {
  const w = (cur && cur.weather && cur.weather[0]) || {};
  const id = Number(w.id) || 800;
  const temp = Number(cur && cur.main && cur.main.temp) || 25;
  const out = [];
  if (id >= 200 && id < 300) out.push('Carry an umbrella and avoid open ground during thunderstorms — lightning is most dangerous in the 30 minutes before and after the thunder.');
  else if (id >= 300 && id < 600) out.push('Carry an umbrella and grippy shoes — wet roads mean longer braking distances; brake early on slippery surfaces.');
  else if (id >= 600) out.push('Freezing or snowy weather: layer up, wear gloves and shoes with real grip.');
  else if (id >= 700 && id < 800) out.push('Low visibility (fog/smoke): use low beams and slow down; ease off hard outdoor exercise if you have a respiratory condition.');
  else if (temp >= 34) out.push('Scorching heat: drink before you feel thirsty, avoid the sun between 12:00 and 15:00, wear a hat and SPF sun protection.');
  else if (temp <= 5) out.push('Cold weather: layer up and cover fingers and ears.');
  else out.push('Pleasant sky for outdoor plans — good for golden-hour photography and an evening picnic.');
  const wind = Number(cur && cur.wind && cur.wind.speed) || 0;
  if (wind >= 10.8) out.push(`Wind at ${Math.round(wind * 3.6)} km/h — tie down anything standing in the yard and give motorcyclists extra room.`);
  if (air && air.list && air.list[0]) {
    const aqi = Number(air.list[0].main && air.list[0].main.aqi) || 1;
    if (aqi >= 4) out.push('Air quality index in the unhealthy band — cut outdoor time and watch children and older adults.');
  }
  return out;
}

function tileTemplateUrl(layer) {
  return `${config.weather.tileBase}/${layer}/{z}/{x}/{y}.png?appid=${config.weather.apiKey}`;
}

module.exports = {
  CITIES,
  featuredCities,
  findCity,
  resolveCity,
  geocode,
  getCurrent,
  getForecast,
  getAir,
  getAirForecast,
  getFeaturedSnapshot,
  OW_CODES,
  describe,
  BEAUFORT,
  beaufort,
  AQI_BANDS,
  aqiBand,
  cityAdvice,
  tileTemplateUrl,
  slugify,
  budgetLeft,
  WeatherDownError,
};
