const express = require('express');
const fs = require('fs/promises'); // version async
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 30056;
const DATA_DIR = path.join(__dirname, 'data');
const SEARCH_INTERVAL = 30000; // 30 secondes entre chaque recherche
const REFRESH_INTERVAL = 5000; // 5 secondes de délai entre chaque channel
const RETRY_DELAY = 60000; // 1 minute avant retry
const MAX_RETRIES = 5;

fs.mkdir(DATA_DIR, { recursive: true });

let channels = [];
let failCount = {};
let channelDataCache = {}; // cache en mémoire pour éviter fs à chaque fois
const registeredRoutes = new Set(); // stocke les routes déjà créées

// Chargement des channels
async function loadChannels() {
  try {
    const file = path.join(__dirname, 'channels.json');
    const data = await fs.readFile(file, 'utf8');
    channels = JSON.parse(data);
  } catch {
    channels = [];
  }
}

// Sauvegarde channels
async function saveChannels() {
  await fs.writeFile(path.join(__dirname, 'channels.json'), JSON.stringify(channels, null, 2));
}

function getTimestamp() {
  return new Date().toISOString();
}

function isRouteAlreadyRegistered(routePath) {
  return registeredRoutes.has(routePath);
}

// Charger toutes les données existantes des fichiers JSON au démarrage
async function loadAllChannelData() {
  console.log('📦 Chargement des données existantes...');
  let loadedCount = 0;

  for (const channelId of channels) {
    const filePath = path.join(DATA_DIR, `${channelId}.json`);
    try {
      const fileData = await fs.readFile(filePath, 'utf8');
      const history = JSON.parse(fileData);
      channelDataCache[channelId] = history;
      loadedCount++;
      console.log(`  ✅ ${channelId}: ${history.length} entrées chargées`);
    } catch (err) {
      console.log(`  ⚠️ ${channelId}: Aucune donnée existante`);
    }
  }

  console.log(`📦 ${loadedCount}/${channels.length} channels chargés en cache`);
}

// Fonction unique pour fetch les données et mettre à jour cache + fichier
async function fetchChannelData(channelId) {
  const apiURL = `https://backend.mixerno.space/api/youtube/estv3/${channelId}`;
  const filePath = path.join(DATA_DIR, `${channelId}.json`);

  if (failCount[channelId] >= MAX_RETRIES) return;

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

    // Charger l'historique existant du fichier si le cache est vide
    let history = channelDataCache[channelId];
    if (!history) {
      try {
        const fileData = await fs.readFile(filePath, 'utf8');
        history = JSON.parse(fileData);
        console.log(`📂 Chargé ${history.length} entrées depuis le fichier pour ${channelId}`);
      } catch (err) {
        console.log(`📄 Nouveau fichier pour ${channelId}`);
        history = []; // Fichier n'existe pas encore
      }
    }

    const beforeFilter = history.length;
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    history = history.filter(e => new Date(e.timestamp).getTime() > twoDaysAgo);
    const afterFilter = history.length;

    if (beforeFilter !== afterFilter) {
      console.log(`🗑️ Filtré ${beforeFilter - afterFilter} entrées anciennes pour ${channelId}`);
    }

    history.push(newEntry);

    // Limiter à 1000 entrées max pour éviter la surcharge mémoire
    if (history.length > 1000) {
      history = history.slice(-1000); // Garde les 1000 dernières
      console.log(`⚠️ Historique tronqué à 1000 entrées pour ${channelId}`);
    }

    channelDataCache[channelId] = history;
    await fs.writeFile(filePath, JSON.stringify(history, null, 2));

    failCount[channelId] = 0;
    console.log(`✅ ${newEntry.name} (${channelId}): ${newEntry.subscribers.toLocaleString()} abonnés`);
  } catch (err) {
    failCount[channelId] = (failCount[channelId] || 0) + 1;
    console.error(`❌ Erreur pour ${channelId}: ${err.message}`);
    setTimeout(() => fetchChannelData(channelId), RETRY_DELAY);
  }
}

// Nettoyage automatique du cache pour éviter la fuite mémoire
function cleanupCache() {
  const cacheSize = Object.keys(channelDataCache).length;
  const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;

  console.log(`🧹 Nettoyage du cache (${cacheSize} channels, ${memBefore.toFixed(2)} MB utilisés)`);

  channelDataCache = {}; // Vide complètement le cache

  // Forcer le garbage collector si disponible
  if (global.gc) {
    global.gc();
  }

  const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`✅ Cache vidé - RAM: ${memAfter.toFixed(2)} MB (libéré: ${(memBefore - memAfter).toFixed(2)} MB)`);
}

// Lancer le nettoyage toutes les 15 minutes (au lieu de 1h)
setInterval(cleanupCache, 15 * 60 * 1000); // 15 minutes



// Setup route UNIQUEMENT (pas de timer ici)
function registerChannelRoute(channelId) {
  const routePath = `/data/${channelId}`;

  if (isRouteAlreadyRegistered(routePath)) {
    return;
  }

  // On enregistre la route
  registeredRoutes.add(routePath);

  const filePath = path.join(DATA_DIR, `${channelId}.json`);
  app.get(routePath, async (req, res) => {
    try {
      const data = channelDataCache[channelId] || await fs.readFile(filePath, 'utf8');
      res.send(data);
    } catch {
      res.status(404).json({ error: 'Data not found' });
    }
  });
}

// Scheduler centralisé - UN SEUL timer pour TOUS les channels
let schedulerRunning = false;
let totalUpdates = 0;
let cycleStartTime = Date.now();

async function startUpdateScheduler() {
  if (schedulerRunning) {
    console.log('⚠️ Scheduler déjà en cours, ignorer');
    return;
  }
  schedulerRunning = true;
  console.log(`🔄 Démarrage du scheduler centralisé pour ${channels.length} channels...`);
  console.log(`⏱️ Temps estimé pour un cycle complet: ${Math.round(channels.length * REFRESH_INTERVAL / 1000 / 60)} minutes`);

  let currentIndex = 0;

  const runNextUpdate = async () => {
    if (channels.length === 0) {
      setTimeout(runNextUpdate, 1000);
      return;
    }

    // Log de progression tous les 100 channels
    if (currentIndex % 100 === 0 && currentIndex > 0) {
      const elapsed = (Date.now() - cycleStartTime) / 1000;
      const progress = ((currentIndex / channels.length) * 100).toFixed(1);
      console.log(`📊 Progression: ${currentIndex}/${channels.length} (${progress}%) - ${totalUpdates} mises à jour - ${elapsed.toFixed(0)}s écoulées`);
    }

    // Début d'un nouveau cycle
    if (currentIndex === 0 && totalUpdates > 0) {
      const cycleTime = (Date.now() - cycleStartTime) / 1000 / 60;
      console.log(`🔄 Nouveau cycle démarré - Cycle précédent: ${cycleTime.toFixed(1)} minutes`);
      cycleStartTime = Date.now();
    }

    const channelId = channels[currentIndex];
    currentIndex = (currentIndex + 1) % channels.length;

    try {
      await fetchChannelData(channelId);
      totalUpdates++;
    } catch (err) {
      console.error(`Scheduler error for ${channelId}:`, err);
    }

    setTimeout(runNextUpdate, REFRESH_INTERVAL);
  };

  runNextUpdate();
}

// Génération de noms aléatoires
function generateRandomName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz@!1234567890';
  return Array.from({ length: Math.floor(Math.random() * 60) + 1 },
    () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Recherche via API externe
async function searchChannels(query) {
  const encodedQuery = encodeURIComponent(JSON.stringify({ json: { query } }));
  const url = `https://proxy.socialstats.app/YouTube.Channels.search?input=${encodedQuery}`;

  try {
    const res = await fetch(url);

    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`⏳ Rate limit hit for search "${query}" (429). Skipping.`);
        return [];
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid JSON response: ${text.substring(0, 50)}...`);
    }

    // Parsing de la réponse spécifique
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

// Auto scan (modifié pour utiliser la nouvelle API avec des termes aléatoires)
let autoScanRunning = false;
let newChannelsFound = 0;

async function autoScan() {
  if (autoScanRunning) {
    console.log('⚠️ AutoScan déjà en cours, ignorer');
    return;
  }
  autoScanRunning = true;
  console.log('🔍 Démarrage de l\'auto-scan...');

  setInterval(async () => {
    const name = generateRandomName().substring(0, 3); // Recherche courte pour plus de résultats
    try {
      const results = await searchChannels(name);
      let addedInThisScan = 0;

      for (const item of results) {
        if (!channels.includes(item.id)) {
          channels.push(item.id);
          await saveChannels();
          registerChannelRoute(item.id);
          newChannelsFound++;
          addedInThisScan++;

          console.log(`📡 Nouveau channel #${newChannelsFound}: ${item.name} (${item.id})`);

          // IMPORTANT: Récupérer immédiatement les données du nouveau channel
          try {
            await fetchChannelData(item.id);
          } catch (fetchErr) {
            console.error(`❌ Erreur lors de la récupération des données pour ${item.id}: ${fetchErr.message}`);
          }
        }
      }

      if (addedInThisScan > 0) {
        console.log(`🔍 Scan terminé: ${addedInThisScan} nouveaux channels ajoutés (Total: ${channels.length})`);
      }
    } catch (err) {
      console.error(`🔍 Erreur autoScan "${name}": ${err.message}`);
    }
  }, SEARCH_INTERVAL);
}

// Route de recherche pour le frontend
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ results: [] });

  const results = await searchChannels(query);
  res.json({ results });
});

// Route pour les statistiques globales
app.get('/api/stats', async (req, res) => {
  try {
    let totalSubscribers = 0;
    let totalChannels = channels.length;

    // Calculer le total des abonnés
    for (const channelId of channels) {
      let history = channelDataCache[channelId];

      if (!history || history.length === 0) {
        const filePath = path.join(DATA_DIR, `${channelId}.json`);
        try {
          const fileData = await fs.readFile(filePath, 'utf8');
          history = JSON.parse(fileData);
        } catch {
          history = [];
        }
      }

      const latest = history[history.length - 1];
      if (latest && latest.subscribers) {
        totalSubscribers += latest.subscribers;
      }
    }

    res.json({
      totalChannels,
      totalSubscribers
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Routes API
app.get('/api/channels', async (req, res) => {
  // Pagination params
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;
  const search = (req.query.search || '').toLowerCase();

  // Prepare all data first (needed for sorting)
  const allData = await Promise.all(channels.map(async (channelId) => {
    let history = channelDataCache[channelId];

    if (!history || history.length === 0) {
      const filePath = path.join(DATA_DIR, `${channelId}.json`);
      try {
        const fileData = await fs.readFile(filePath, 'utf8');
        history = JSON.parse(fileData);
        channelDataCache[channelId] = history;
      } catch {
        history = [];
      }
    }

    const latest = history[history.length - 1] || {};
    return {
      channelId,
      subscribers: latest.subscribers || 0,
      viewCount: latest.viewCount || 0,
      videoCount: latest.videoCount || 0,
      timestamp: latest.timestamp || 'N/A',
      name: latest.name || channelId,
      avatar: latest.avatar || ''
    };
  }));

  // Filtrage recherche
  let filtered = allData;
  if (search) {
    filtered = allData.filter(c =>
      c.channelId.toLowerCase().includes(search) ||
      (c.name && c.name.toLowerCase().includes(search))
    );
  }

  // Sort by subscribers (descending)
  filtered.sort((a, b) => b.subscribers - a.subscribers);

  // Pagination
  const total = filtered.length;
  const start = (page - 1) * limit;
  const end = start + limit;
  const paged = filtered.slice(start, end);

  res.json({ channels: paged, total });
});

app.post('/add-channel', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing channel ID' });
  if (channels.includes(id)) return res.status(400).json({ error: 'Channel already added' });

  channels.push(id);
  await saveChannels();
  registerChannelRoute(id);
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

// Init
(async () => {
  await loadChannels();

  // Charger toutes les données existantes AVANT de fetcher de nouvelles données
  await loadAllChannelData();

  // Setup des routes pour tous les channels
  channels.forEach(channelId => {
    registerChannelRoute(channelId);
  });

  // Lancer le scheduler centralisé (UN SEUL timer pour tous)
  startUpdateScheduler();

  autoScan();

  app.listen(PORT, () => console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`));
})();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
