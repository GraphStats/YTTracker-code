const API_BASE = '/api';
let channels = [];
let chartInstance = null;

// Pagination state
let currentPage = 1;
const PAGE_SIZE = 50;
let totalChannels = 0;
let totalPages = 1;

// DOM Elements
const grid = document.getElementById('channelGrid');
const searchInput = document.getElementById('searchInput');
const addModal = document.getElementById('addModal');
const detailsModal = document.getElementById('detailsModal');
const newChannelInput = document.getElementById('newChannelId');

// Pagination controls
let paginationContainer = document.getElementById('pagination');
if (!paginationContainer) {
    paginationContainer = document.createElement('div');
    paginationContainer.id = 'pagination';
    paginationContainer.style.textAlign = 'center';
    paginationContainer.style.margin = '1rem 0';
    grid.parentNode.insertBefore(paginationContainer, grid.nextSibling);
}

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
    // Loading Screen Logic
    const loadingScreen = document.getElementById('loading-screen');
    const randomDuration = Math.floor(Math.random() * (4000 - 2000 + 1) + 2000); // 2-4 seconds

    setTimeout(() => {
        loadingScreen.classList.add('hidden');
        // Optional: Remove from DOM after transition
        setTimeout(() => {
            loadingScreen.style.display = 'none';
        }, 500);
    }, randomDuration);

    fetchChannels();
    fetchGlobalStats(); // Charger les stats globales
    setInterval(() => fetchChannels(currentPage, searchInput.value), 60000); // Auto refresh every 60s
    setInterval(() => fetchGlobalStats(), 60000); // Refresh stats every 60s
});

// Fetch Data (paginated)
async function fetchChannels(page = 1, search = '') {
    try {
        let url = `${API_BASE}/channels?page=${page}&limit=${PAGE_SIZE}`;
        if (search) url += `&search=${encodeURIComponent(search)}`;
        const res = await fetch(url);
        const data = await res.json();
        channels = data.channels;
        totalChannels = data.total;
        totalPages = Math.ceil(totalChannels / PAGE_SIZE);
        updateGrid(channels);
        renderPagination();
    } catch (err) {
        console.error('Failed to fetch channels:', err);
    }
}

// Fetch Global Stats
async function fetchGlobalStats() {
    try {
        const res = await fetch(`${API_BASE}/stats`);
        const data = await res.json();

        document.getElementById('totalChannels').textContent = formatNumber(data.totalChannels);
        document.getElementById('totalSubscribers').textContent = formatNumber(data.totalSubscribers);
    } catch (err) {
        console.error('Failed to fetch global stats:', err);
    }
}

// Update Grid
function updateGrid(data) {
    if (data.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: var(--text-secondary);">No channels found.</div>';
        return;
    }

    // Check if we need to rebuild the grid
    const existingCards = grid.querySelectorAll('[data-channel-id]');
    const existingIds = Array.from(existingCards).map(card => card.getAttribute('data-channel-id'));
    const newIds = data.map(c => c.channelId);

    const needsRebuild = existingIds.length !== newIds.length ||
        !existingIds.every(id => newIds.includes(id));

    if (needsRebuild) {
        // Rebuild entire grid
        renderGrid(data);
    } else {
        // Just update values
        data.forEach(channel => {
            const subCount = document.getElementById(`sub-count-${channel.channelId}`);
            if (subCount) {
                subCount.textContent = formatNumber(channel.subscribers);
            }
            // Update avatar and name in case they changed
            const card = grid.querySelector(`[data-channel-id="${channel.channelId}"]`);
            if (card) {
                const img = card.querySelector('.avatar');
                const name = card.querySelector('.info h3');
                if (img) img.src = channel.avatar || 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y';
                if (name) name.textContent = channel.name || channel.channelId;
            }
        });
    }
}

// Render Grid (full rebuild)
function renderGrid(data) {
    grid.innerHTML = data.map(channel => `
        <div class="glass channel-card" onclick="openDetails('${channel.channelId}')" data-channel-id="${channel.channelId}">
            <div class="card-header">
                <img src="${channel.avatar || 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y'}" alt="${channel.name}" class="avatar">
                <div class="info">
                    <h3>${channel.name || channel.channelId}</h3>
                    <p>${channel.channelId}</p>
                </div>
            </div>
            <div class="stats">
                <div class="sub-count" id="sub-count-${channel.channelId}">${formatNumber(channel.subscribers)}</div>
                <div class="live-indicator">
                    <div class="live-dot"></div> Live
                </div>
            </div>
        </div>
    `).join('');
}

// Pagination rendering
function renderPagination() {
    if (totalPages <= 1) {
        paginationContainer.innerHTML = '';
        return;
    }
    // Style amélioré pour les boutons
    const btnStyle = `
        style="
            background: rgba(255,255,255,0.08);
            border: none;
            color: #fff;
            padding: 0.5rem 1.2rem;
            margin: 0 0.3rem;
            border-radius: 1.5rem;
            font-size: 1rem;
            font-weight: 500;
            box-shadow: 0 2px 8px 0 rgba(0,0,0,0.08);
            backdrop-filter: blur(6px);
            cursor: pointer;
            transition: background 0.2s, color 0.2s, transform 0.1s;
        "
        onmouseover="this.style.background='rgba(255,255,255,0.18)'"
        onmouseout="this.style.background='rgba(255,255,255,0.08)'"
    `;
    const btnDisabledStyle = `
        style="
            background: rgba(255,255,255,0.04);
            border: none;
            color: #aaa;
            padding: 0.5rem 1.2rem;
            margin: 0 0.3rem;
            border-radius: 1.5rem;
            font-size: 1rem;
            font-weight: 500;
            box-shadow: none;
            cursor: not-allowed;
            opacity: 0.6;
        "
        disabled
    `;

    let html = `<button ${currentPage === 1 ? btnDisabledStyle : btnStyle} onclick="gotoPage(${currentPage - 1})">&lt; Précédent</button>`;
    html += ` <span style="font-size:1.1rem;font-weight:600;color:#ff0033;vertical-align:middle;">Page ${currentPage} / ${totalPages}</span> `;
    html += `<button ${currentPage === totalPages ? btnDisabledStyle : btnStyle} onclick="gotoPage(${currentPage + 1})">Suivant &gt;</button>`;
    paginationContainer.innerHTML = html;
}

// Pagination navigation
window.gotoPage = function (page) {
    if (page < 1 || page > totalPages) return;
    currentPage = page;
    fetchChannels(currentPage, searchInput.value);
};

// Search
searchInput.addEventListener('input', (e) => {
    currentPage = 1;
    fetchChannels(currentPage, e.target.value);
});

function filterChannels(query) {
    // Plus utilisé côté frontend, la recherche est côté backend
    return channels;
}

// Add Channel
function openAddModal() {
    addModal.classList.add('active');
    document.getElementById('newChannelSearch').focus();
}

function closeAddModal() {
    addModal.classList.remove('active');
    newChannelInput.value = '';
    document.getElementById('newChannelSearch').value = '';
    document.getElementById('searchResults').innerHTML = '';
}

// Search for new channels
const newChannelSearch = document.getElementById('newChannelSearch');
let searchTimeout;

if (newChannelSearch) {
    newChannelSearch.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim();

        if (query.length < 2) {
            document.getElementById('searchResults').innerHTML = '';
            return;
        }

        searchTimeout = setTimeout(async () => {
            try {
                const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
                const data = await res.json();
                renderSearchResults(data.results);
            } catch (e) {
                console.error('Search failed', e);
            }
        }, 500);
    });
}

function renderSearchResults(results) {
    const container = document.getElementById('searchResults');
    if (!results || results.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--text-secondary);">No results found</div>';
        return;
    }

    container.innerHTML = results.map(channel => `
        <div class="search-result-item" onclick="selectChannel('${channel.id}')" 
             style="display:flex; align-items:center; padding:0.5rem; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.05); transition:background 0.2s;">
            <img src="${channel.avatar}" style="width:40px; height:40px; border-radius:50%; margin-right:1rem;">
            <div>
                <div style="font-weight:600;">${channel.name} ${channel.verified ? '<i class="fas fa-check-circle" style="color:#aaa; font-size:0.8em;"></i>' : ''}</div>
                <div style="font-size:0.8rem; color:var(--text-secondary);">${channel.id}</div>
            </div>
            <i class="fas fa-plus" style="margin-left:auto; color:var(--primary-color);"></i>
        </div>
    `).join('');
}

function selectChannel(id) {
    newChannelInput.value = id;
    addChannel();
}

async function addChannel() {
    const id = newChannelInput.value.trim();
    if (!id) return;

    const btn = document.querySelector('#addModal .btn-primary');
    const originalText = btn.innerText;
    btn.innerText = 'Adding...';
    btn.disabled = true;

    try {
        const res = await fetch('/add-channel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });

        if (res.ok) {
            closeAddModal();
            fetchChannels(currentPage, searchInput.value);
        } else {
            const err = await res.json();
            alert(err.error || 'Failed to add channel');
        }
    } catch (e) {
        alert('Error adding channel');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// Details & Chart
async function openDetails(channelId) {
    const channel = channels.find(c => c.channelId === channelId);
    if (!channel) return;

    document.getElementById('modalName').innerText = channel.name || 'Unknown';
    document.getElementById('modalId').innerText = channel.channelId;
    document.getElementById('modalAvatar').src = channel.avatar || '';
    document.getElementById('modalSubs').innerText = formatNumber(channel.subscribers);

    detailsModal.classList.add('active');

    // Fetch history for chart
    try {
        const res = await fetch(`/data/${channelId}`);
        const history = await res.json();
        renderChart(history);

        // Setup update button
        const updateBtn = document.getElementById('updateBtn');
        updateBtn.onclick = () => requestUpdate(channelId, updateBtn);

    } catch (e) {
        console.error('Failed to load history', e);
    }
}

async function requestUpdate(channelId, btn) {
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';

    try {
        const res = await fetch(`/api/update/${channelId}`, { method: 'POST' });
        if (res.ok) {
            // Refresh data
            const historyRes = await fetch(`/data/${channelId}`);
            const history = await historyRes.json();
            renderChart(history);

            // Update stats in modal
            const latest = history[history.length - 1];
            if (latest) {
                document.getElementById('modalSubs').innerText = formatNumber(latest.subscribers);
            }

            fetchChannels(); // Refresh grid too
        }
    } catch (e) {
        console.error('Update failed', e);
    } finally {
        btn.innerHTML = '<i class="fas fa-check"></i> Updated';
        setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }, 5000);
    }
}

function closeDetailsModal() {
    detailsModal.classList.remove('active');
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }
}

function renderChart(history) {
    const ctx = document.getElementById('growthChart').getContext('2d');

    if (chartInstance) chartInstance.destroy();

    // Downsample if too many points (optional, but good for performance)
    const dataPoints = history.length > 100 ? history.filter((_, i) => i % Math.ceil(history.length / 100) === 0) : history;

    const labels = dataPoints.map(p => new Date(p.timestamp).toLocaleTimeString());
    const data = dataPoints.map(p => p.subscribers);

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Abonnés',
                data: data,
                borderColor: '#ff0033',
                backgroundColor: 'rgba(255, 0, 51, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 0
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1
                }
            },
            scales: {
                x: {
                    display: false,
                    grid: { display: false }
                },
                y: {
                    grid: {
                        color: 'rgba(255,255,255,0.05)'
                    },
                    ticks: {
                        color: '#a0a0b0',
                        callback: function (value) {
                            return formatNumber(value);
                        }
                    }
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            }
        }
    });
}

// Utilities
function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Close modals on outside click
window.onclick = function (event) {
    if (event.target == addModal) closeAddModal();
    if (event.target == detailsModal) closeDetailsModal();
}
