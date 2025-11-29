const API_BASE = '/api';
let channels = [];
let chartInstance = null;

// DOM Elements
const grid = document.getElementById('channelGrid');
const searchInput = document.getElementById('searchInput');
const addModal = document.getElementById('addModal');
const detailsModal = document.getElementById('detailsModal');
const newChannelInput = document.getElementById('newChannelId');

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
    setInterval(fetchChannels, 60000); // Auto refresh every 5s
});

// Fetch Data
async function fetchChannels() {
    try {
        const res = await fetch(`${API_BASE}/channels`);
        const data = await res.json();
        channels = data;
        updateGrid(filterChannels(searchInput.value));
    } catch (err) {
        console.error('Failed to fetch channels:', err);
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

// Search
searchInput.addEventListener('input', (e) => {
    const filtered = filterChannels(e.target.value);
    renderGrid(filtered); // On search, rebuild grid
});

function filterChannels(query) {
    if (!query) return channels;
    const lower = query.toLowerCase();
    return channels.filter(c =>
        c.channelId.toLowerCase().includes(lower) ||
        (c.name && c.name.toLowerCase().includes(lower))
    );
}

// Add Channel
function openAddModal() {
    addModal.classList.add('active');
    newChannelInput.focus();
}

function closeAddModal() {
    addModal.classList.remove('active');
    newChannelInput.value = '';
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
            fetchChannels();
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
    } catch (e) {
        console.error('Failed to load history', e);
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
