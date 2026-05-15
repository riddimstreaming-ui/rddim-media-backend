const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Allow requests from your Vercel frontend ──
app.use(cors({
  origin: [
    'https://riddim-media.vercel.app',
    'https://riddim-media-git-main-riddimstreaming-uis-projects.vercel.app',
    /\.vercel\.app$/,
    'http://localhost:3000',
    'http://localhost:5500',
  ],
  methods: ['GET'],
}));

app.use(express.json());

// ── Addon endpoints ──
const TORRENTIO_BASE = 'https://torrentio.strem.fun';
const TPB_BASE       = 'https://thepiratebay-plus.strem.fun';
const TIMEOUT_MS     = 8000;

// Helper: fetch with timeout
async function fetchWithTimeout(url, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Parse quality from stream name
function getQuality(name = '') {
  const n = name.toUpperCase();
  if (n.includes('2160') || n.includes('4K') || n.includes('UHD')) return '4K';
  if (n.includes('1080')) return '1080p';
  if (n.includes('720'))  return '720p';
  if (n.includes('480'))  return '480p';
  return 'SD';
}

// Parse size from stream name
function parseSize(name = '') {
  const m = name.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
  return m ? `${m[1]} ${m[2].toUpperCase()}` : null;
}

// Parse seeders from stream name
function parseSeeds(name = '') {
  const m = name.match(/👤\s*(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

// Normalise a raw stream object from any addon
function normaliseStream(s, source) {
  const name  = s.name || s.title || 'Unknown';
  const quality = getQuality(name);
  const size    = parseSize(name);
  const seeds   = parseSeeds(name);

  return {
    source,
    name:      name.replace(/👤[^\n]*/g, '').trim(),
    quality,
    size,
    seeds,
    infoHash:  s.infoHash || null,
    url:       s.url      || null,
    // Magnet link — usable by WebTorrent
    magnet:    s.infoHash
      ? `magnet:?xt=urn:btih:${s.infoHash}&tr=wss://tracker.openwebtorrent.com&tr=wss://tracker.webtorrent.dev`
      : null,
  };
}

// Sort streams: quality first, then seeds
const QUALITY_ORDER = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'SD': 4 };
function sortStreams(streams) {
  return streams.sort((a, b) => {
    const qDiff = (QUALITY_ORDER[a.quality] ?? 5) - (QUALITY_ORDER[b.quality] ?? 5);
    if (qDiff !== 0) return qDiff;
    return (b.seeds || 0) - (a.seeds || 0);
  });
}

// ── ROUTE: GET /streams/:type/:imdbId ──
// Example: GET /streams/movie/tt15398776
//          GET /streams/series/tt14452776
app.get('/streams/:type/:imdbId', async (req, res) => {
  const { type, imdbId } = req.params;

  if (!imdbId.startsWith('tt')) {
    return res.status(400).json({ error: 'Invalid IMDB ID — must start with tt' });
  }

  const torrentioUrl = `${TORRENTIO_BASE}/sort=qualitysize|qualityfilter=other,scr,cam/stream/${type}/${imdbId}.json`;
  const tpbUrl       = `${TPB_BASE}/stream/${type}/${imdbId}.json`;

  // Fetch both addons in parallel — don't fail if one is down
  const [torrentioResult, tpbResult] = await Promise.allSettled([
    fetchWithTimeout(torrentioUrl),
    fetchWithTimeout(tpbUrl),
  ]);

  const streams = [];

  if (torrentioResult.status === 'fulfilled') {
    const raw = torrentioResult.value.streams || [];
    raw.filter(s => s.infoHash).forEach(s => streams.push(normaliseStream(s, 'Torrentio')));
  }

  if (tpbResult.status === 'fulfilled') {
    const raw = tpbResult.value.streams || [];
    raw.filter(s => s.infoHash).forEach(s => streams.push(normaliseStream(s, 'TPB+')));
  }

  const sorted = sortStreams(streams);

  res.json({
    imdbId,
    type,
    count:   sorted.length,
    streams: sorted,
    sources: {
      torrentio: torrentioResult.status === 'fulfilled' ? 'ok' : 'error',
      tpb:       tpbResult.status       === 'fulfilled' ? 'ok' : 'error',
    }
  });
});

// ── ROUTE: GET /health ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Riddim Media Backend', uptime: process.uptime() });
});

// ── ROUTE: GET / ──
app.get('/', (req, res) => {
  res.json({
    name:    'Riddim Media Backend',
    version: '1.0.0',
    routes:  [
      'GET /streams/:type/:imdbId — fetch streams from Torrentio + TPB+',
      'GET /health               — health check',
    ],
  });
});

app.listen(PORT, () => {
  console.log(`✅ Riddim Media backend running on port ${PORT}`);
});
