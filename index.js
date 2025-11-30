const express = require('express');
const fs = require('fs/promises');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const PORT = 30056;
const DATA_DIR = path.join(__dirname, 'data');
const CHANNELS_FILE = path.join(__dirname, 'channels.json');
const BACKUP_FILE = path.join(__dirname, 'channels.backup.json');

const SEARCH_INTERVAL = 3000; // 3 secondes entre chaque recherche auto
const BATCH_SIZE = 5;         // Nombre de requêtes en parallèle
const BATCH_INTERVAL = 1000;  // Délai entre chaque batch (1 seconde)
const RETRY_DELAY = 60000;     // 1 minute avant retry en cas d'erreur
const MAX_RETRIES = 5;
const CACHE_CLEANUP_INTERVAL = 15 * 60 * 1000; // 15 minutes

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// STATE MANAGEMENT
// ==========================================
let channels = [];
let failCount = {};

// Cache Split Strategy:
// 1. latestStatsCache: Always in memory. Contains ONLY the latest snapshot for listing/sorting.
// 2. historyCache: Loaded on demand. Contains full history arrays. Cleared periodically.
let latestStatsCache = {};
let historyCache = {};
const registeredRoutes = new Set();

// ==========================================
// HELPER FUNCTIONS
// ==========================================
function getTimestamp() {
  return new Date().toISOString();
}

function generateRandomName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz@!1234567890';
  return Array.from({ length: Math.floor(Math.random() * 60) + 1 },
    () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ==========================================
// CORE DATA LOGIC
// ==========================================

// Ensure Data Directory Exists
fs.mkdir(DATA_DIR, { recursive: true }).catch(console.error);

async function loadChannels() {
  try {
    // 1. Try to load the main file
    const data = await fs.readFile(CHANNELS_FILE, 'utf8');
    channels = JSON.parse(data);
    console.log(`✅ Loaded ${channels.length} channels from ${CHANNELS_FILE}`);

    // 2. Create/Update backup on successful load
    await fs.writeFile(BACKUP_FILE, data);
  } catch (err) {
    console.error(`⚠️ Error loading ${CHANNELS_FILE}:`, err.message);

    // 3. If main file fails, try backup
    try {
      if (err.code !== 'ENOENT') {
        console.warn('⚠️ Main file corrupted? Attempting to restore from backup...');
      }

      const backupData = await fs.readFile(BACKUP_FILE, 'utf8');
      channels = JSON.parse(backupData);
      console.log(`✅ Restored ${channels.length} channels from backup.`);

      // Restore main file
      await fs.writeFile(CHANNELS_FILE, backupData);
    } catch (backupErr) {
      if (err.code === 'ENOENT' && backupErr.code === 'ENOENT') {
        console.log('wm No channels file or backup found. Starting with empty list.');
        channels = [];
      } else {
        console.error('❌ CRITICAL ERROR: Unable to load channels from file or backup.');
        console.error('Main Error:', err);
        console.error('Backup Error:', backupErr);
        process.exit(1); // Exit to prevent data overwrite
      }
    }
  }
}

async function saveChannels() {
  const tempFile = `${CHANNELS_FILE}.tmp`;
  try {
    await fs.writeFile(tempFile, JSON.stringify(channels, null, 2));
    await fs.rename(tempFile, CHANNELS_FILE);
  } catch (err) {
    console.error('❌ Error saving channels:', err);
  }
}

// Load only the latest stats into memory at startup
async function loadInitialStats() {
  console.log('📦 Chargement des statistiques initiales...');
  let loadedCount = 0;

  for (const channelId of channels) {
    const filePath = path.join(DATA_DIR, `${channelId}.json`);
    try {
      const fileData = await fs.readFile(filePath, 'utf8');
      const history = JSON.parse(fileData);

      if (history.length > 0) {
        const latest = history[history.length - 1];
        latestStatsCache[channelId] = latest;
        loadedCount++;
      }
    } catch (err) {
      // Ignore missing files or errors during initial load
    }
  }
  console.log(`📦 ${loadedCount}/${channels.length} channels chargés (Latest Stats)`);
}

// Get history (from cache or disk)
async function getChannelHistory(channelId) {
  if (historyCache[channelId]) {
    return historyCache[channelId];
  }

  const filePath = path.join(DATA_DIR, `${channelId}.json`);
  try {
    const fileData = await fs.readFile(filePath, 'utf8');
    const history = JSON.parse(fileData);
    historyCache[channelId] = history;
    return history;
  } catch (err) {
    return []; // Return empty if file doesn't exist
  }
}

// Fetch and Update Logic
async function fetchChannelData(channelId) {
  const apiURL = `https://backend.mixerno.space/api/youtube/estv3/${channelId}`;
  const filePath = path.join(DATA_DIR, `${channelId}.json`);

  if ((failCount[channelId] || 0) >= MAX_RETRIES) return;

  try {
    const response = await fetch(apiURL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    const item = data.items?.[0];
    const newEntry = {
      timestamp: getTimestamp(),
      channelId,
      subscribers: Number(item?.statistics?.subscriberCount || 0),
      viewCount: Number(item?.statistics?.viewCount || 0),
      videoCount: Number(item?.statistics?.videoCount || 0),
      name: item?.snippet?.title || 'Unknown',
      avatar: item?.snippet?.thumbnails?.default?.url || ''
    };

    // Update Latest Stats Cache (Immediate)
    latestStatsCache[channelId] = newEntry;

    // Update History (Load -> Append -> Save)
    let history = await getChannelHistory(channelId);

    // Filter old data (keep last 2 days)
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    history = history.filter(e => new Date(e.timestamp).getTime() > twoDaysAgo);

    history.push(newEntry);

    // Limit size
    if (history.length > 1000) {
      history = history.slice(-1000);
    }

    // Update Cache & Disk
    historyCache[channelId] = history;
    await fs.writeFile(filePath, JSON.stringify(history, null, 2));

    failCount[channelId] = 0;
    console.log(`✅ ${newEntry.name} (${channelId}): ${newEntry.subscribers.toLocaleString()} abonnés`);

  } catch (err) {
    failCount[channelId] = (failCount[channelId] || 0) + 1;
    console.error(`❌ Erreur pour ${channelId}: ${err.message}`);
    setTimeout(() => fetchChannelData(channelId), RETRY_DELAY);
  }
}

// Cache Cleanup (Only clears history, keeps latest stats)
function cleanupCache() {
  const historyKeys = Object.keys(historyCache).length;
  const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;

  console.log(`🧹 Nettoyage du cache historique (${historyKeys} entrées)...`);

  historyCache = {}; // Clear history cache only

  if (global.gc) global.gc();

  const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`✅ Cache vidé - RAM: ${memAfter.toFixed(2)} MB (libéré: ${(memBefore - memAfter).toFixed(2)} MB)`);
}

setInterval(cleanupCache, CACHE_CLEANUP_INTERVAL);

// ==========================================
// SCHEDULER & AUTO-SCAN
// ==========================================
let schedulerRunning = false;
let totalUpdates = 0;
let cycleStartTime = Date.now();

async function startUpdateScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  console.log(`🔄 Démarrage du scheduler (Batch: ${BATCH_SIZE}, Interval: ${BATCH_INTERVAL}ms)`);

  let currentIndex = 0;

  const runNextBatch = async () => {
    if (channels.length === 0) {
      setTimeout(runNextBatch, 1000);
      return;
    }

    // Cycle tracking
    if (currentIndex === 0 && totalUpdates > 0) {
      const cycleTime = (Date.now() - cycleStartTime) / 1000 / 60;
      console.log(`🔄 Cycle terminé en ${cycleTime.toFixed(1)} min. Redémarrage.`);
      cycleStartTime = Date.now();
    }

    // Prepare Batch
    const batch = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const channelId = channels[currentIndex];
      batch.push(fetchChannelData(channelId));

      currentIndex = (currentIndex + 1) % channels.length;

      // Stop if we wrapped around to 0 in this batch (optional, but good for clean cycles)
      if (currentIndex === 0) break;
    }

    try {
      await Promise.allSettled(batch);
      totalUpdates += batch.length;
    } catch (err) {
      console.error('Batch error:', err);
    }

    setTimeout(runNextBatch, BATCH_INTERVAL);
  };

  runNextBatch();
}

// Auto Scan
async function searchChannels(query) {
  const encodedQuery = encodeURIComponent(JSON.stringify({ json: { query } }));
  const url = `https://proxy.socialstats.app/YouTube.Channels.search?input=${encodedQuery}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];

    const text = await res.text();
    const data = JSON.parse(text);
    const results = data?.result?.data?.json || [];

    return results.map(item => ({
      id: item.id,
      name: item.title,
      avatar: item.thumb,
      verified: item.verified
    }));
  } catch (err) {
    console.error(`🔍 Erreur recherche "${query}": ${err.message}`);
    return [];
  }
}

async function autoScan() {
  console.log('🔍 Démarrage de l\'auto-scan...');
  setInterval(async () => {
    const name = generateRandomName().substring(0, 3);
    try {
      const results = await searchChannels(name);
      let added = 0;

      for (const item of results) {
        if (!channels.includes(item.id)) {
          channels.push(item.id);
          await saveChannels();
          registerChannelRoute(item.id);
          added++;

          // Fetch initial data immediately
          fetchChannelData(item.id).catch(e => console.error(e));
        }
      }
      if (added > 0) console.log(`� AutoScan: ${added} nouveaux channels.`);
    } catch (err) {
      // Silent fail for scan errors
    }
  }, SEARCH_INTERVAL);
}

// ==========================================
// ROUTES
// ==========================================

// Dynamic Route Registration
function registerChannelRoute(channelId) {
  const routePath = `/data/${channelId}`;
  if (registeredRoutes.has(routePath)) return;
  registeredRoutes.add(routePath);

  app.get(routePath, async (req, res) => {
    try {
      const data = await getChannelHistory(channelId);
      res.send(data);
    } catch {
      res.status(404).json({ error: 'Data not found' });
    }
  });
}

// Main List API (Optimized)
app.get('/api/channels', (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;
  const search = (req.query.search || '').toLowerCase();

  // 1. Convert Cache to Array
  let allData = Object.values(latestStatsCache);

  // 2. Filter
  if (search) {
    allData = allData.filter(c =>
      (c.channelId && c.channelId.toLowerCase().includes(search)) ||
      (c.name && c.name.toLowerCase().includes(search))
    );
  }

  // 3. Sort
  allData.sort((a, b) => b.subscribers - a.subscribers);

  // 4. Paginate
  const total = allData.length;
  const start = (page - 1) * limit;
  const paged = allData.slice(start, start + limit);

  res.json({ channels: paged, total });
});

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ results: [] });
  const results = await searchChannels(query);
  res.json({ results });
});

app.get('/api/stats', (req, res) => {
  const totalChannels = channels.length;
  const totalSubscribers = Object.values(latestStatsCache)
    .reduce((sum, c) => sum + (c.subscribers || 0), 0);

  res.json({ totalChannels, totalSubscribers });
});

app.post('/add-channel', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing channel ID' });
  if (channels.includes(id)) return res.status(400).json({ error: 'Channel already added' });

  channels.push(id);
  await saveChannels();
  registerChannelRoute(id);

  // Trigger fetch
  fetchChannelData(id);

  res.json({ success: true, route: `/data/${id}` });
});

app.post('/api/update/:id', async (req, res) => {
  const { id } = req.params;
  if (!channels.includes(id)) return res.status(404).json({ error: 'Channel not found' });

  try {
    await fetchChannelData(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==========================================
// INITIALIZATION
// ==========================================
(async () => {
  await loadChannels();
  await loadInitialStats();

  // Register routes
  channels.forEach(registerChannelRoute);

  // Start background tasks
  startUpdateScheduler();
  autoScan();

  app.listen(PORT, () => console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`));
})();
