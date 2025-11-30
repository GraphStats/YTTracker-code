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

let isSaving = false;
let savePending = false;

async function saveChannels() {
  if (isSaving) {
    savePending = true;
    return;
  }
  isSaving = true;

  try {
    do {
      savePending = false;
      const tempFile = `${CHANNELS_FILE}.tmp`;
      // Use a unique temp file name to avoid any remaining race conditions with external processes
      // though the lock handles internal concurrency.

      await fs.writeFile(tempFile, JSON.stringify(channels, null, 2));
      await fs.rename(tempFile, CHANNELS_FILE);
    } while (savePending);
  } catch (err) {
    console.error('❌ Error saving channels:', err);
  } finally {
    isSaving = false;
  }
}

// ... (loadInitialStats, getChannelHistory, fetchChannelData, cleanupCache remain unchanged)

// ...

async function autoScan() {
  console.log('🔍 Démarrage de l\'auto-scan...');
  setInterval(async () => {
    const name = generateRandomName().substring(0, 3);
    try {
      const results = await searchChannels(name);
      let added = 0;
      let shouldSave = false;

      for (const item of results) {
        if (!channels.includes(item.id)) {
          channels.push(item.id);
          shouldSave = true;
          registerChannelRoute(item.id);
          added++;

          // Fetch initial data immediately
          fetchChannelData(item.id).catch(e => console.error(e));
        }
      }

      if (shouldSave) {
        await saveChannels();
      }

      if (added > 0) console.log(`🚀 AutoScan: ${added} nouveaux channels.`);
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
