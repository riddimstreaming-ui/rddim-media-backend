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
    /\.railway\.app$/,
    'http://localhost:3000',
    'http://localhost:5500',
  ],
  methods: ['GET'],
}));

app.use(express.json());

// ── Addon endpoints ──
const TORRENTIO_BASE = 'https://torrentio.strem.fun';
const TPB_BASE       = 'https://thepiratebay-plus.strem.fun';
const NUVIO_BASE     = 'https://nuviostreams.hayd.uk';
const TIMEOUT_MS     = 15000;

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

  // Add comprehensive tracker list — UDP for desktop, WSS for browser
  const trackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.tiny-vps.com:6969/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://opentracker.i2p.rocks:6969/announce',
    'udp://tracker.internetwarriors.net:1337/announce',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
  ].map(t => `&tr=${encodeURIComponent(t)}`).join('');

  return {
    source,
    name:      name.replace(/👤[^\n]*/g, '').trim(),
    quality,
    size,
    seeds,
    infoHash:  s.infoHash || null,
    url:       s.url      || null,
    magnet:    s.infoHash
      ? `magnet:?xt=urn:btih:${s.infoHash}${trackers}`
      : null,
  };
}

// Sort streams: 1080p first, then 720p, then others — exclude 4K (too large for WebTorrent)
const QUALITY_ORDER = { '1080p': 0, '720p': 1, '480p': 2, 'SD': 3, '4K': 4 };
function sortStreams(streams) {
  return streams
    .filter(s => s.quality !== '4K') // Remove 4K — too large for browser streaming
    .sort((a, b) => {
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
  const nuvioUrl     = `${NUVIO_BASE}/stream/${type}/${imdbId}.json`;

  // Fetch all three sources in parallel
  const [torrentioResult, tpbResult, nuvioResult] = await Promise.allSettled([
    fetchWithTimeout(torrentioUrl),
    fetchWithTimeout(tpbUrl),
    fetchWithTimeout(nuvioUrl),
  ]);

  const streams      = [];
  const httpStreams   = [];

  if (torrentioResult.status === 'fulfilled') {
    const raw = torrentioResult.value.streams || [];
    raw.filter(s => s.infoHash).forEach(s => streams.push(normaliseStream(s, 'Torrentio')));
  }

  if (tpbResult.status === 'fulfilled') {
    const raw = tpbResult.value.streams || [];
    raw.filter(s => s.infoHash).forEach(s => streams.push(normaliseStream(s, 'TPB+')));
  }

  // Nuvio returns direct HTTP streams — handle separately
  if (nuvioResult.status === 'fulfilled') {
    const raw = nuvioResult.value.streams || [];
    raw.filter(s => s.url).forEach(s => {
      httpStreams.push({
        source:   'Nuvio',
        name:     (s.name || s.title || 'Direct Stream').replace(/👤[^\n]*/g, '').trim(),
        quality:  getQuality(s.name || s.title || ''),
        size:     parseSize(s.name || ''),
        seeds:    0,
        infoHash: null,
        url:      s.url,
        magnet:   null,
      });
    });
  }

  const sortedTorrents = sortStreams(streams);

  // Torrents first (more content), Nuvio as instant-play fallback
  const allStreams = [...sortedTorrents, ...httpStreams];

  res.json({
    imdbId,
    type,
    count:   allStreams.length,
    streams: allStreams,
    sources: {
      torrentio: torrentioResult.status === 'fulfilled' ? 'ok' : 'error',
      tpb:       tpbResult.status       === 'fulfilled' ? 'ok' : 'error',
      nuvio:     nuvioResult.status     === 'fulfilled' ? 'ok' : 'error',
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
