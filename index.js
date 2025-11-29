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
const SEARCH_INTERVAL = 50000;
const REFRESH_INTERVAL = 120000;
const RETRY_DELAY = 30000;
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
    console.log(`📈 Donnée ajoutée pour ${channelId}`);
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



// Setup route + timer pour chaque channel
function setupChannel(channelId, delayMs = 0) {
  const routePath = `/data/${channelId}`;

  if (isRouteAlreadyRegistered(routePath)) {
    console.log(`⚠️ Route déjà setup pour ${channelId}`);
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

  // Et on lance la collecte avec délai initial pour éviter 502
  setTimeout(() => {
    fetchChannelData(channelId);
    setInterval(() => fetchChannelData(channelId), REFRESH_INTERVAL);
  }, delayMs);
}

// Génération de noms aléatoires
function generateRandomName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length: Math.floor(Math.random() * 60) + 1 },
    () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Auto scan
async function autoScan() {
  setInterval(async () => {
    const name = generateRandomName();
    const url = `https://mixerno.space/api/youtube-channel-counter/search/${name}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (Array.isArray(data.list)) {
        for (const item of data.list) {
          const id = item[2];
          if (!channels.includes(id)) {
            channels.push(id);
            await saveChannels();
            setupChannel(id);
            console.log(`📡 Ajout auto : ${item[0]} (${id})`);
          }
        }
      }
    } catch (err) {
      console.error(`🔍 Erreur recherche "${name}": ${err.message}`);
    }
  }, SEARCH_INTERVAL);
}

// Routes API
app.get('/api/channels', async (req, res) => {
  const result = await Promise.all(channels.map(async (channelId) => {
    let history = channelDataCache[channelId];

    // Si le cache est vide, charger depuis le fichier
    if (!history || history.length === 0) {
      const filePath = path.join(DATA_DIR, `${channelId}.json`);
      try {
        const fileData = await fs.readFile(filePath, 'utf8');
        history = JSON.parse(fileData);
        // Recharger dans le cache pour les prochaines requêtes
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
  res.json(result);
});

app.post('/add-channel', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing channel ID' });
  if (channels.includes(id)) return res.status(400).json({ error: 'Channel already added' });

  channels.push(id);
  await saveChannels();
  setupChannel(id);
  res.json({ success: true, route: `/data/${id}` });
});

// Init
(async () => {
  await loadChannels();

  // Charger toutes les données existantes AVANT de fetcher de nouvelles données
  await loadAllChannelData();

  // Espacer les requêtes initiales pour éviter 502
  channels.forEach((channelId, index) => {
    setupChannel(channelId, index * 200); // 2 secondes entre chaque
  });

  autoScan();

  app.listen(PORT, () => console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`));
})();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
