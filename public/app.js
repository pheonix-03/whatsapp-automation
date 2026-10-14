// State Management
let currentTab = 'dashboard';
let currentStage = 'ALL';
let leadsData = [];
let templatesData = [];
let activeLeadId = null;
let currentLeadData = null;
let searchTimeout = null;

// Media Uploads State
const uploadedMedia = {
    direct: null,
    drawer: null,
    camp: null
};

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();
    initApp();
});

async function initApp() {
    await checkWhatsAppStatus();
    loadEngineConfigs();
    setInterval(checkWhatsAppStatus, 4000); // Polling WhatsApp connection state
    loadDashboard();
    loadTemplates();
}

function triggerMediaPicker(target, type) {
    const inputId = target === 'direct' ? 'direct-wa-media-input' : (target === 'drawer' ? 'drawer-media-input' : 'camp-media-input');
    const input = document.getElementById(inputId);
    if (input) {
        input.accept = type === 'image' ? 'image/png,image/jpeg,image/jpg,image/webp,image/gif,image/*' : 'video/mp4,video/*';
        input.click();
    }
}

// Media Upload Handler (Image/Video/PDF)
async function handleMediaUpload(input, target) {
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    const mediaKind = isImage ? 'Image' : (isVideo ? 'Video' : 'File');
    const formData = new FormData();
    formData.append('media', file);

    showToast(`Uploading ${file.name}...`, 'info');
    try {
        const res = await fetch('/api/upload-media', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            uploadedMedia[target] = data;
            
            const previewEl = document.getElementById(`${target}-media-preview`);
            const nameEl = document.getElementById(`${target}-media-name`);
            const iconEl = document.getElementById(`${target}-media-icon`);
            if (previewEl && nameEl) {
                nameEl.textContent = data.fileName;
                if (iconEl) {
                    iconEl.setAttribute('data-lucide', isImage ? 'image' : (isVideo ? 'file-video' : 'paperclip'));
                }
                previewEl.classList.remove('hidden');
            }
            showToast(`${mediaKind} attached! It will be sent with your message as caption.`, 'success');
            lucide.createIcons();
        } else {
            showToast(data.error || 'Upload failed', 'error');
        }
    } catch (e) {
        showToast('Upload error: ' + e.message, 'error');
    }
}

function clearMedia(target) {
    uploadedMedia[target] = null;
    const previewEl = document.getElementById(`${target}-media-preview`);
    const inputEl = document.getElementById(`${target === 'direct' ? 'direct-wa-media-input' : (target === 'drawer' ? 'drawer-media-input' : 'camp-media-input')}`);
    if (previewEl) previewEl.classList.add('hidden');
    if (inputEl) inputEl.value = '';
}

// ==========================================
// NAVIGATION & TABS
// ==========================================
function switchTab(tabId) {
    currentTab = tabId;

    // Update Nav buttons
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const activeNav = document.getElementById(`nav-${tabId}`);
    if (activeNav) activeNav.classList.add('active');

    // Update Content Views
    document.querySelectorAll('.view-content').forEach(el => el.classList.add('hidden'));
    const targetView = document.getElementById(`view-${tabId}`);
    if (targetView) targetView.classList.remove('hidden');

    // Load respective tab data
    if (tabId === 'dashboard') loadDashboard();
    else if (tabId === 'leads') loadLeads();
    else if (tabId === 'whatsapp') loadWhatsAppLogs();
    else if (tabId === 'campaigns') loadCampaigns();
    else if (tabId === 'automations') loadAutomations();
    else if (tabId === 'templates') loadTemplates();
    else if (tabId === 'compliance') loadComplianceDashboard();

    lucide.createIcons();
}

// ==========================================
// TOAST NOTIFICATIONS
// ==========================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    const colors = {
        success: 'bg-emerald-600 text-white',
        error: 'bg-rose-600 text-white',
        info: 'bg-slate-900 text-white'
    };
    toast.className = `toast px-4 py-2.5 rounded-lg text-xs font-semibold shadow-lg flex items-center gap-2 ${colors[type] || colors.info}`;
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ==========================================
// WHATSAPP CONNECTION STATUS & ENGINE
// ==========================================
async function checkWhatsAppStatus() {
    try {
        const res = await fetch('/api/whatsapp/status');
        const data = await res.json();
        updateWhatsAppUI(data);
    } catch (err) {
        console.warn('Failed to fetch WhatsApp status:', err);
    }
}

function updateWhatsAppUI(wa) {
    const topPill = document.getElementById('top-status-pill');
    const topText = document.getElementById('top-status-text');
    const sideDot = document.getElementById('wa-indicator-dot');
    const sideText = document.getElementById('sidebar-wa-text');
    const sideBadge = document.getElementById('nav-wa-badge');
    const waStatusBadge = document.getElementById('wa-status-badge');
    const waDeviceDetail = document.getElementById('wa-device-detail');
    const qrContainer = document.getElementById('wa-qr-container');

    const activeEngineName = document.getElementById('active-engine-name');
    const badgeBuiltin = document.getElementById('badge-builtin-status');
    const badgeOpenwa = document.getElementById('badge-openwa-status');
    const badgeCloud = document.getElementById('badge-cloud-status');

    // Update active engine badge and indicator
    if (wa.activeEngine === 'OPENWA_GATEWAY') {
        if (activeEngineName) activeEngineName.textContent = 'OpenWA Gateway (Self-Hosted)';
        if (badgeOpenwa) {
            badgeOpenwa.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800';
            badgeOpenwa.textContent = 'ACTIVE';
        }
        if (badgeBuiltin) {
            badgeBuiltin.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500';
            badgeBuiltin.textContent = 'STANDBY';
        }
        if (badgeCloud) {
            badgeCloud.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500';
            badgeCloud.textContent = 'STANDBY';
        }
    } else if (wa.activeEngine === 'META_CLOUD_API') {
        if (activeEngineName) activeEngineName.textContent = 'Meta WhatsApp Cloud API';
        if (badgeCloud) {
            badgeCloud.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800';
            badgeCloud.textContent = 'ACTIVE';
        }
        if (badgeBuiltin) {
            badgeBuiltin.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500';
            badgeBuiltin.textContent = 'STANDBY';
        }
        if (badgeOpenwa) {
            badgeOpenwa.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500';
            badgeOpenwa.textContent = 'STANDBY';
        }
    } else {
        if (activeEngineName) activeEngineName.textContent = 'Built-in Web Engine';
        if (badgeBuiltin) {
            badgeBuiltin.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800';
            badgeBuiltin.textContent = 'ACTIVE';
        }
        if (badgeOpenwa) {
            badgeOpenwa.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500';
            badgeOpenwa.textContent = 'STANDBY';
        }
        if (badgeCloud) {
            badgeCloud.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500';
            badgeCloud.textContent = 'STANDBY';
        }
    }

    const isEngineOpenWA = wa.activeEngine === 'OPENWA_GATEWAY';
    const engineLabel = isEngineOpenWA ? 'OpenWA Gateway' : 'WhatsApp Web';

    if (wa.status === 'CONNECTED') {
        const num = wa.userInfo ? `+${wa.userInfo.number}` : 'Active';
        const name = wa.userInfo ? wa.userInfo.pushname : '';

        topPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
        topPill.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span>${engineLabel}: ${num}</span>`;

        sideDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500';
        sideText.textContent = `🟢 ${name || num}`;
        sideBadge.className = 'ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-emerald-950 text-emerald-400';
        sideBadge.textContent = 'Online';

        if (waStatusBadge) {
            waStatusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800';
            waStatusBadge.textContent = `${engineLabel.toUpperCase()} CONNECTED`;
        }
        if (waDeviceDetail) {
            waDeviceDetail.textContent = `Engine: ${engineLabel} | Phone: ${num} | Pushname: ${name} | Queue: ${wa.queueLength} pending`;
        }
        if (qrContainer) {
            qrContainer.innerHTML = `
                <div class="text-center p-4">
                    <div class="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3">
                        <i data-lucide="check-circle-2" class="w-8 h-8"></i>
                    </div>
                    <h4 class="font-bold text-slate-900 text-sm">${engineLabel} Connected!</h4>
                    <p class="text-xs text-slate-500 mt-1">Ready to send and receive automated messages.</p>
                </div>
            `;
            lucide.createIcons();
        }
    } else if (wa.status === 'SCAN_QR') {
        topPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 cursor-pointer';
        topPill.onclick = () => switchTab('whatsapp');
        topPill.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span><span>Scan ${engineLabel} QR Code</span>`;

        sideDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse';
        sideText.textContent = 'Scan QR Needed';
        sideBadge.className = 'ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-amber-900 text-amber-300';
        sideBadge.textContent = 'Action Required';

        if (waStatusBadge) {
            waStatusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800';
            waStatusBadge.textContent = `WAITING FOR ${engineLabel.toUpperCase()} QR SCAN`;
        }
        if (waDeviceDetail) {
            waDeviceDetail.textContent = `Point your phone camera to pair with ${engineLabel}.`;
        }
        if (qrContainer && wa.qrDataUrl) {
            qrContainer.innerHTML = `
                <img src="${wa.qrDataUrl}" alt="${engineLabel} QR Code" class="w-56 h-56 rounded-lg shadow-sm border border-slate-200 bg-white p-2">
                <span class="text-[11px] text-slate-500 mt-2 font-medium">Scan with WhatsApp &gt; Linked Devices &gt; Link a Device</span>
            `;
        } else if (qrContainer) {
            qrContainer.innerHTML = `
                <div class="text-center p-4">
                    <i data-lucide="loader" class="w-8 h-8 text-blue-600 animate-spin mx-auto mb-2"></i>
                    <p class="text-xs text-slate-700 font-bold">Generating ${engineLabel} QR Code...</p>
                </div>
            `;
            lucide.createIcons();
        }
    } else if (wa.status === 'INITIALIZING') {
        sideDot.className = 'w-2.5 h-2.5 rounded-full bg-blue-500 animate-ping';
        sideText.textContent = 'Launching Engine...';
        if (waStatusBadge) {
            waStatusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-800';
            waStatusBadge.textContent = 'STARTING HEADLESS BROWSER...';
        }
        if (qrContainer) {
            qrContainer.innerHTML = `
                <div class="animate-pulse text-center p-4">
                    <i data-lucide="loader" class="w-8 h-8 text-blue-600 animate-spin mx-auto mb-2"></i>
                    <p class="text-xs text-slate-700 font-bold">Starting WhatsApp session...</p>
                    <p class="text-[11px] text-slate-400 mt-1">Launching headless browser engine (approx 10-15s)...</p>
                </div>
            `;
            lucide.createIcons();
        }
    } else if (wa.status === 'FAILED') {
        topPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200 cursor-pointer';
        topPill.onclick = () => switchTab('whatsapp');
        topPill.innerHTML = `<span class="w-2 h-2 rounded-full bg-rose-500"></span><span>WhatsApp: Connection Error</span>`;

        sideDot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
        sideText.textContent = 'Connection Failed';
        sideBadge.className = 'ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-rose-950 text-rose-400';
        sideBadge.textContent = 'Failed';

        if (waStatusBadge) {
            waStatusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800';
            waStatusBadge.textContent = 'FAILED / RESTART NEEDED';
        }
        if (waDeviceDetail) {
            waDeviceDetail.textContent = wa.lastError || 'Unable to connect to WhatsApp Web session.';
        }
        if (qrContainer) {
            qrContainer.innerHTML = `
                <div class="text-center p-3">
                    <div class="w-12 h-12 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center mx-auto mb-2">
                        <i data-lucide="alert-triangle" class="w-6 h-6"></i>
                    </div>
                    <h4 class="font-bold text-slate-900 text-sm">Connection Error</h4>
                    <p class="text-[11px] text-rose-600 font-medium mt-1 mb-3 max-w-[220px] mx-auto truncate" title="${wa.lastError || ''}">${wa.lastError || 'Failed to initialize session.'}</p>
                    <div class="flex flex-col gap-2 items-center">
                        <button onclick="reconnectWhatsApp()" class="w-full px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs flex items-center justify-center gap-1.5">
                            <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>
                            <span>Retry Connection</span>
                        </button>
                        <button onclick="resetWhatsAppSession()" class="w-full px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                            <span>Reset & Scan Fresh QR</span>
                        </button>
                    </div>
                </div>
            `;
            lucide.createIcons();
        }
    } else {
        topPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200 cursor-pointer';
        topPill.onclick = () => switchTab('whatsapp');
        topPill.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-400"></span><span>WhatsApp: Offline</span>`;

        sideDot.className = 'w-2.5 h-2.5 rounded-full bg-slate-500';
        sideText.textContent = 'Not Connected';
        sideBadge.className = 'ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-800 text-slate-400';
        sideBadge.textContent = 'Offline';

        if (waStatusBadge) {
            waStatusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700';
            waStatusBadge.textContent = 'DISCONNECTED';
        }
        if (waDeviceDetail) {
            waDeviceDetail.textContent = 'Click "Scan QR / Link Device" to start WhatsApp engine.';
        }
        if (qrContainer) {
            qrContainer.innerHTML = `
                <div class="text-center p-3">
                    <button onclick="reconnectWhatsApp()" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-2 shadow mx-auto">
                        <i data-lucide="power" class="w-4 h-4"></i>
                        <span>Start & Link WhatsApp</span>
                    </button>
                </div>
            `;
            lucide.createIcons();
        }
    }
}

async function reconnectWhatsApp() {
    showToast('Initializing WhatsApp headless engine...', 'info');
    try {
        await fetch('/api/whatsapp/connect', { method: 'POST' });
        checkWhatsAppStatus();
    } catch (e) {
        showToast('Error connecting WhatsApp: ' + e.message, 'error');
    }
}

async function disconnectWhatsApp() {
    if (!confirm('Are you sure you want to disconnect WhatsApp session?')) return;
    try {
        await fetch('/api/whatsapp/disconnect', { method: 'POST' });
        showToast('WhatsApp disconnected.', 'info');
        checkWhatsAppStatus();
    } catch (e) {
        showToast('Error disconnecting: ' + e.message, 'error');
    }
}

async function resetWhatsAppSession() {
    if (!confirm('This will disconnect and clear your saved WhatsApp session so you can scan a brand new QR code. Continue?')) {
        return;
    }
    showToast('Resetting WhatsApp session & generating new QR code...', 'info');
    try {
        const res = await fetch('/api/whatsapp/reset', { method: 'POST' });
        const data = await res.json();
        showToast(data.message || 'Session reset successfully!', 'success');
        checkWhatsAppStatus();
    } catch (e) {
        showToast('Error resetting session: ' + e.message, 'error');
    }
}

function openWhatsAppModal() {
    switchTab('whatsapp');
}

// ==========================================
// WHATSAPP DISPATCH ENGINES (BUILT-IN / OPENWA / CLOUD API)
// ==========================================
let currentEngineTab = 'builtin';

function selectEngineTab(engine) {
    currentEngineTab = engine;
    const builtinCard = document.getElementById('card-engine-builtin');
    const openwaCard = document.getElementById('card-engine-openwa');
    const cloudCard = document.getElementById('card-engine-cloudapi');
    const openwaPanel = document.getElementById('panel-engine-openwa');
    const cloudPanel = document.getElementById('panel-engine-cloudapi');

    if (builtinCard) builtinCard.className = 'p-4 rounded-xl border-2 border-slate-200 hover:border-emerald-400 bg-white cursor-pointer transition-all hover:shadow-xs flex flex-col justify-between';
    if (openwaCard) openwaCard.className = 'p-4 rounded-xl border-2 border-slate-200 hover:border-blue-400 bg-white cursor-pointer transition-all hover:shadow-xs flex flex-col justify-between';
    if (cloudCard) cloudCard.className = 'p-4 rounded-xl border-2 border-slate-200 hover:border-purple-400 bg-white cursor-pointer transition-all hover:shadow-xs flex flex-col justify-between';

    if (openwaPanel) openwaPanel.classList.add('hidden');
    if (cloudPanel) cloudPanel.classList.add('hidden');

    if (engine === 'builtin') {
        if (builtinCard) builtinCard.className = 'p-4 rounded-xl border-2 border-emerald-500 bg-emerald-50/40 cursor-pointer transition-all hover:shadow-xs flex flex-col justify-between';
    } else if (engine === 'openwa') {
        if (openwaCard) openwaCard.className = 'p-4 rounded-xl border-2 border-blue-500 bg-blue-50/40 cursor-pointer transition-all hover:shadow-xs flex flex-col justify-between';
        if (openwaPanel) openwaPanel.classList.remove('hidden');
    } else if (engine === 'cloudapi') {
        if (cloudCard) cloudCard.className = 'p-4 rounded-xl border-2 border-purple-500 bg-purple-50/40 cursor-pointer transition-all hover:shadow-xs flex flex-col justify-between';
        if (cloudPanel) cloudPanel.classList.remove('hidden');
    }
    lucide.createIcons();
}

async function loadEngineConfigs() {
    try {
        // Load OpenWA Config
        const resOpenwa = await fetch('/api/openwa/config');
        const dataOpenwa = await resOpenwa.json();
        if (dataOpenwa.config) {
            const cfg = dataOpenwa.config;
            const toggle = document.getElementById('openwa-enabled-toggle');
            const urlInput = document.getElementById('openwa-server-url');
            const keyInput = document.getElementById('openwa-api-key');
            const sessionInput = document.getElementById('openwa-session-id');
            if (toggle) toggle.checked = !!cfg.enabled;
            if (urlInput) urlInput.value = cfg.serverUrl || 'http://localhost:2785/api';
            if (keyInput) keyInput.value = cfg.apiKey || '';
            if (sessionInput) sessionInput.value = cfg.sessionId || 'default';
        }

        // Load Meta Cloud API Config
        const resCloud = await fetch('/api/whatsapp-cloud/config');
        const dataCloud = await resCloud.json();
        if (dataCloud.config) {
            const cfg = dataCloud.config;
            const toggle = document.getElementById('cloudapi-enabled-toggle');
            const phoneInput = document.getElementById('cloud-phone-number-id');
            const tokenInput = document.getElementById('cloud-access-token');
            const bizInput = document.getElementById('cloud-business-account-id');
            if (toggle) toggle.checked = !!cfg.enabled;
            if (phoneInput) phoneInput.value = cfg.phoneNumberId || '';
            if (tokenInput) tokenInput.value = cfg.accessToken || '';
            if (bizInput) bizInput.value = cfg.businessAccountId || '';
        }
    } catch (e) {
        console.warn('Error loading engine configs:', e);
    }
}

async function toggleOpenWAEngine(enabled) {
    try {
        const serverUrl = document.getElementById('openwa-server-url')?.value.trim() || 'http://localhost:2785/api';
        const apiKey = document.getElementById('openwa-api-key')?.value.trim() || '';
        const sessionId = document.getElementById('openwa-session-id')?.value.trim() || 'default';

        const res = await fetch('/api/openwa/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, serverUrl, apiKey, sessionId })
        });
        const data = await res.json();
        if (data.success) {
            showToast(enabled ? 'OpenWA Gateway enabled as outgoing engine!' : 'OpenWA Gateway disabled.', 'success');
            checkWhatsAppStatus();
        } else {
            showToast(data.error || 'Failed to update OpenWA setting', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

async function saveOpenWAConfig() {
    const serverUrl = document.getElementById('openwa-server-url')?.value.trim() || 'http://localhost:2785/api';
    const apiKey = document.getElementById('openwa-api-key')?.value.trim() || '';
    const sessionId = document.getElementById('openwa-session-id')?.value.trim() || 'default';
    const enabled = document.getElementById('openwa-enabled-toggle')?.checked || false;

    try {
        const res = await fetch('/api/openwa/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, serverUrl, apiKey, sessionId })
        });
        const data = await res.json();
        if (data.success) {
            showToast('OpenWA settings saved successfully!', 'success');
            checkWhatsAppStatus();
        } else {
            showToast(data.error || 'Failed to save OpenWA config', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

async function testOpenWAConnection() {
    const serverUrl = document.getElementById('openwa-server-url')?.value.trim() || 'http://localhost:2785/api';
    const apiKey = document.getElementById('openwa-api-key')?.value.trim() || '';
    const sessionId = document.getElementById('openwa-session-id')?.value.trim() || 'default';

    showToast('Testing connection to OpenWA Gateway...', 'info');
    try {
        const res = await fetch('/api/openwa/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverUrl, apiKey, sessionId })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Connected to OpenWA Gateway! Status: ${data.sessionStatus || 'OK'}`, 'success');
        } else {
            showToast(`OpenWA Gateway unreachable: ${data.error || 'Check server URL & port 2785'}`, 'error');
        }
    } catch (e) {
        showToast('Connection failed: ' + e.message, 'error');
    }
}

async function startOpenWASession() {
    showToast('Starting OpenWA session & generating QR code...', 'info');
    try {
        const res = await fetch('/api/openwa/start', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('OpenWA session active! Scan QR code to link device.', 'success');
            await checkWhatsAppStatus();
            const qrCard = document.getElementById('wa-qr-container');
            if (qrCard) qrCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            showToast(data.error || 'Failed to start OpenWA session', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

async function toggleCloudAPIEngine(enabled) {
    try {
        const phoneNumberId = document.getElementById('cloud-phone-number-id')?.value.trim() || '';
        const accessToken = document.getElementById('cloud-access-token')?.value.trim() || '';
        const businessAccountId = document.getElementById('cloud-business-account-id')?.value.trim() || '';

        const res = await fetch('/api/whatsapp-cloud/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, phoneNumberId, accessToken, businessAccountId })
        });
        const data = await res.json();
        if (data.success) {
            showToast(enabled ? 'Meta Cloud API enabled as outgoing engine!' : 'Meta Cloud API disabled.', 'success');
            checkWhatsAppStatus();
        } else {
            showToast(data.error || 'Failed to update Cloud API', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

async function saveCloudAPIConfig() {
    const phoneNumberId = document.getElementById('cloud-phone-number-id')?.value.trim() || '';
    const accessToken = document.getElementById('cloud-access-token')?.value.trim() || '';
    const businessAccountId = document.getElementById('cloud-business-account-id')?.value.trim() || '';
    const enabled = document.getElementById('cloudapi-enabled-toggle')?.checked || false;

    try {
        const res = await fetch('/api/whatsapp-cloud/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, phoneNumberId, accessToken, businessAccountId })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Meta Cloud API settings saved successfully!', 'success');
            checkWhatsAppStatus();
        } else {
            showToast(data.error || 'Failed to save Cloud API settings', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

async function testCloudAPIConnection() {
    const phoneNumberId = document.getElementById('cloud-phone-number-id')?.value.trim() || '';
    const accessToken = document.getElementById('cloud-access-token')?.value.trim() || '';

    showToast('Testing connection to Meta Cloud API...', 'info');
    try {
        const res = await fetch('/api/whatsapp-cloud/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumberId, accessToken })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Connected to Meta Cloud API! Verified Phone: ${data.data?.display_phone_number || phoneNumberId}`, 'success');
        } else {
            showToast(`Meta Cloud API failed: ${data.error || 'Check Phone ID & Access Token'}`, 'error');
        }
    } catch (e) {
        showToast('Connection failed: ' + e.message, 'error');
    }
}

// ==========================================
// DASHBOARD
// ==========================================
async function loadDashboard() {
    try {
        const res = await fetch('/api/dashboard');
        const data = await res.json();

        // Stats
        document.getElementById('dash-total-leads').textContent = data.stats.totalLeads;
        document.getElementById('dash-won-leads').textContent = data.stats.wonLeads;
        document.getElementById('dash-conversion-rate').textContent = data.stats.conversionRate;
        document.getElementById('dash-wa-sent').textContent = data.stats.messagesSent;
        document.getElementById('dash-wa-received').textContent = data.stats.messagesReceived;

        // Stage breakdown cards
        const stageColors = {
            'New': 'bg-blue-50 border-blue-200 text-blue-700',
            'Contacted': 'bg-amber-50 border-amber-200 text-amber-700',
            'Qualified': 'bg-purple-50 border-purple-200 text-purple-700',
            'Proposal Sent': 'bg-indigo-50 border-indigo-200 text-indigo-700',
            'Won': 'bg-emerald-50 border-emerald-200 text-emerald-700',
            'Lost': 'bg-rose-50 border-rose-200 text-rose-700'
        };

        const stagesContainer = document.getElementById('dash-stages-container');
        stagesContainer.innerHTML = '';
        const allStages = ['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Won', 'Lost'];
        
        allStages.forEach(st => {
            const found = data.stages.find(s => s.stage === st);
            const count = found ? found.count : 0;
            const colorClass = stageColors[st] || 'bg-slate-50 border-slate-200 text-slate-700';

            const card = document.createElement('div');
            card.className = `p-3.5 rounded-xl border ${colorClass} cursor-pointer hover:shadow-xs transition-all`;
            card.onclick = () => {
                switchTab('leads');
                filterByStage(st);
            };
            card.innerHTML = `
                <div class="text-[11px] font-bold uppercase tracking-wider">${st}</div>
                <div class="text-xl font-bold mt-1">${count}</div>
            `;
            stagesContainer.appendChild(card);
        });

        // Recent activities stream
        const actsContainer = document.getElementById('dash-activities-list');
        if (data.recentActivities.length === 0) {
            actsContainer.innerHTML = `<p class="text-xs text-slate-400 py-4 text-center">No recent activities logged yet.</p>`;
        } else {
            actsContainer.innerHTML = data.recentActivities.map(a => {
                const leadName = a.first_name ? `${a.first_name} ${a.last_name || ''}` : 'Lead';
                const timeStr = new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const icon = a.type.includes('WHATSAPP') ? 'message-square' : (a.type.includes('STAGE') ? 'trending-up' : 'user');
                const iconColor = a.type === 'WHATSAPP_SENT' ? 'text-emerald-500' : (a.type === 'WHATSAPP_RECEIVED' ? 'text-indigo-500' : 'text-blue-500');

                return `
                    <div class="flex items-start gap-3 p-3 bg-slate-50/70 hover:bg-slate-50 rounded-lg border border-slate-100 transition-colors">
                        <div class="p-2 rounded-md bg-white border border-slate-200 ${iconColor} shrink-0">
                            <i data-lucide="${icon}" class="w-3.5 h-3.5"></i>
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center justify-between">
                                <h4 class="text-xs font-bold text-slate-800 truncate">${a.title} &bull; <span class="text-blue-600">${leadName}</span></h4>
                                <span class="text-[10px] text-slate-400 shrink-0">${timeStr}</span>
                            </div>
                            <p class="text-xs text-slate-500 truncate mt-0.5">${a.description || ''}</p>
                        </div>
                    </div>
                `;
            }).join('');
        }

        lucide.createIcons();
    } catch (err) {
        console.error('Error loading dashboard:', err);
    }
}

// ==========================================
// LEADS & PIPELINE VIEW
// ==========================================
async function loadLeads() {
    try {
        const priority = document.getElementById('leads-priority-filter').value;
        const source = document.getElementById('leads-source-filter').value;
        const search = document.getElementById('leads-search-input').value;

        let url = `/api/leads?stage=${encodeURIComponent(currentStage)}&priority=${encodeURIComponent(priority)}&source=${encodeURIComponent(source)}`;
        if (search) url += `&search=${encodeURIComponent(search)}`;

        const res = await fetch(url);
        leadsData = await res.json();

        // Update counts on stage tabs
        await updateStageTabCounts();

        renderLeadsTable(leadsData);
    } catch (err) {
        console.error('Error loading leads:', err);
    }
}

async function updateStageTabCounts() {
    try {
        const res = await fetch('/api/dashboard');
        const data = await res.json();
        
        let total = 0;
        const map = {};
        data.stages.forEach(s => {
            map[s.stage] = s.count;
            total += s.count;
        });

        document.getElementById('count-all').textContent = total;
        document.getElementById('count-new').textContent = map['New'] || 0;
        document.getElementById('count-contacted').textContent = map['Contacted'] || 0;
        document.getElementById('count-qualified').textContent = map['Qualified'] || 0;
        document.getElementById('count-proposal').textContent = map['Proposal Sent'] || 0;
        document.getElementById('count-won').textContent = map['Won'] || 0;
        document.getElementById('count-lost').textContent = map['Lost'] || 0;
    } catch (e) {}
}

function filterByStage(stage) {
    currentStage = stage;
    document.querySelectorAll('.stage-tab').forEach(b => {
        if (b.dataset.stage === stage) {
            b.className = 'stage-tab active px-4 py-2.5 text-xs font-bold border-b-2 border-blue-600 text-blue-600 whitespace-nowrap';
        } else {
            b.className = 'stage-tab px-4 py-2.5 text-xs font-semibold text-slate-500 hover:text-slate-800 border-b-2 border-transparent whitespace-nowrap';
        }
    });
    loadLeads();
}

function debounceLeadsSearch(val) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(loadLeads, 300);
}

function handleGlobalSearch(val) {
    switchTab('leads');
    document.getElementById('leads-search-input').value = val;
    loadLeads();
}

function renderLeadsTable(leads) {
    const tbody = document.getElementById('leads-table-body');
    document.getElementById('leads-visible-count').textContent = leads.length;

    if (leads.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center py-10 text-slate-400">No leads found in this view.</td></tr>`;
        return;
    }

    const priorityBadges = {
        'High': 'bg-rose-50 text-rose-700 border border-rose-200',
        'Medium': 'bg-amber-50 text-amber-700 border border-amber-200',
        'Low': 'bg-slate-100 text-slate-600'
    };

    const stageBadges = {
        'New': 'bg-blue-50 text-blue-700 border border-blue-200',
        'Contacted': 'bg-amber-50 text-amber-700 border border-amber-200',
        'Qualified': 'bg-purple-50 text-purple-700 border border-purple-200',
        'Proposal Sent': 'bg-indigo-50 text-indigo-700 border border-indigo-200',
        'Won': 'bg-emerald-50 text-emerald-700 border border-emerald-200',
        'Lost': 'bg-rose-50 text-rose-700 border border-rose-200'
    };

    tbody.innerHTML = leads.map(l => {
        const fullName = `${l.first_name} ${l.last_name || ''}`.trim();
        const stageBadge = stageBadges[l.stage] || 'bg-slate-100 text-slate-600';
        const prioBadge = priorityBadges[l.priority] || 'bg-slate-100 text-slate-600';

        let complianceCell = '';
        if (l.opted_out || (l.suppression_count && l.suppression_count > 0) || l.consent_status === 'REVOKED' || l.consent_status === 'OPTED_OUT') {
            complianceCell = `
                <div class="flex items-center gap-1" onclick="event.stopPropagation()">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-200 flex items-center gap-1">
                        <i data-lucide="ban" class="w-3 h-3"></i> SUPPRESSED
                    </span>
                    <button onclick="openConsentHistoryModal('${l.phone}')" title="View Audit Trail" class="text-[10px] text-slate-400 hover:text-blue-600 underline ml-1">Audit</button>
                </div>
            `;
        } else if (l.consent_status === 'OPTED_IN') {
            complianceCell = `
                <div class="flex items-center gap-1" onclick="event.stopPropagation()">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200 flex items-center gap-1">
                        <i data-lucide="shield-check" class="w-3 h-3"></i> OPTED_IN
                    </span>
                    <button onclick="openConsentHistoryModal('${l.phone}')" title="View Consent Evidence & Audit Trail" class="text-[10px] text-slate-400 hover:text-blue-600 underline ml-1">History</button>
                </div>
            `;
        } else {
            complianceCell = `
                <div class="flex items-center gap-1.5" onclick="event.stopPropagation()">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">No Consent</span>
                    <button onclick="openCaptureConsentModal('${l.phone}')" class="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold transition-colors">+ Opt-In</button>
                </div>
            `;
        }

        return `
            <tr class="hover:bg-slate-50/80 transition-colors cursor-pointer group" onclick="openLeadProfile(${l.id})">
                <td class="py-3 px-4 font-bold text-slate-900 flex items-center gap-2.5">
                    <div class="w-7 h-7 rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-[11px] shrink-0">
                        ${l.first_name.charAt(0)}${(l.last_name || '').charAt(0)}
                    </div>
                    <div>
                        <div class="font-bold text-slate-900 group-hover:text-blue-600">${fullName}</div>
                        <div class="text-[10px] text-slate-400">${l.email || 'No email'}</div>
                    </div>
                </td>
                <td class="py-3 px-4 text-slate-600 font-medium">${l.company || '-'}</td>
                <td class="py-3 px-4">
                    <div class="flex items-center gap-1.5 font-mono text-[11px] text-slate-700">
                        <span>${l.phone}</span>
                        <button onclick="event.stopPropagation(); openLeadQuickChat(${l.id})" title="Chat on WhatsApp" class="p-1 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-600 transition-colors">
                            <i data-lucide="message-square" class="w-3.5 h-3.5"></i>
                        </button>
                    </div>
                </td>
                <td class="py-3 px-4">${complianceCell}</td>
                <td class="py-3 px-4">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${stageBadge}">${l.stage}</span>
                </td>
                <td class="py-3 px-4 font-bold text-blue-600">${l.score || 10}</td>
                <td class="py-3 px-4">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${prioBadge}">${l.priority}</span>
                </td>
                <td class="py-3 px-4 text-slate-500">${l.source || '-'}</td>
                <td class="py-3 px-4 text-right" onclick="event.stopPropagation()">
                    <div class="flex items-center justify-end gap-1">
                        <button onclick="openLeadProfile(${l.id})" class="p-1.5 text-slate-500 hover:text-blue-600 rounded hover:bg-slate-100 transition-colors" title="Open 360° Profile">
                            <i data-lucide="eye" class="w-3.5 h-3.5"></i>
                        </button>
                        <button onclick="deleteLeadDirect(${l.id})" class="p-1.5 text-slate-400 hover:text-rose-600 rounded hover:bg-rose-50 transition-colors" title="Delete">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    lucide.createIcons();
}

// ==========================================
// LEAD 360° DRAWER / PROFILE
// ==========================================
async function openLeadProfile(leadId) {
    activeLeadId = leadId;
    try {
        const res = await fetch(`/api/leads/${leadId}`);
        currentLeadData = await res.json();

        const l = currentLeadData.lead;
        const fullName = `${l.first_name} ${l.last_name || ''}`.trim();

        document.getElementById('drawer-name').textContent = fullName;
        document.getElementById('drawer-sub').textContent = `${l.company || 'Individual'} • ${l.phone}`;
        document.getElementById('drawer-avatar').textContent = `${l.first_name.charAt(0)}${(l.last_name || '').charAt(0)}`;

        // Populate Details Tab
        document.getElementById('drawer-edit-stage').value = l.stage;
        document.getElementById('drawer-edit-priority').value = l.priority;
        document.getElementById('drawer-edit-email').value = l.email || '';
        document.getElementById('drawer-edit-phone').value = l.phone || '';
        document.getElementById('drawer-edit-company').value = l.company || '';
        document.getElementById('drawer-edit-score').value = l.score || 0;
        document.getElementById('drawer-edit-notes').value = l.notes || '';

        // Render Chat & Timeline
        renderDrawerChat(currentLeadData.messages || []);
        renderDrawerTimeline(currentLeadData.activities || []);

        // Populate Template select in chat drawer
        const chatTplSelect = document.getElementById('drawer-chat-template');
        chatTplSelect.innerHTML = `<option value="">-- Choose Template to Insert --</option>` +
            templatesData.map(t => `<option value="${t.id}">${t.name} (${t.category})</option>`).join('');

        switchDrawerTab('chat');
        document.getElementById('lead-drawer').classList.remove('hidden');
        lucide.createIcons();
    } catch (err) {
        showToast('Error opening lead profile: ' + err.message, 'error');
    }
}

function openLeadQuickChat(leadId) {
    openLeadProfile(leadId);
}

function closeLeadDrawer() {
    document.getElementById('lead-drawer').classList.add('hidden');
    activeLeadId = null;
    currentLeadData = null;
}

function switchDrawerTab(tab) {
    const tabs = ['chat', 'timeline', 'details'];
    tabs.forEach(t => {
        const btn = document.getElementById(`drawer-tab-${t}`);
        const view = document.getElementById(`drawer-view-${t}`);
        if (t === tab) {
            btn.className = 'py-3 border-b-2 border-emerald-600 text-emerald-600 font-bold flex items-center gap-1.5';
            view.classList.remove('hidden');
        } else {
            btn.className = 'py-3 border-b-2 border-transparent hover:text-slate-800 flex items-center gap-1.5';
            view.classList.add('hidden');
        }
    });
    lucide.createIcons();
}

function renderDrawerChat(messages) {
    const container = document.getElementById('drawer-chat-messages');
    if (messages.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-400 text-center py-10">No WhatsApp messages exchanged yet.<br>Type below to send the first message!</p>`;
        return;
    }

    container.innerHTML = messages.map(m => {
        const isOut = m.direction === 'OUTGOING';
        const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const bubbleBg = isOut ? 'bg-emerald-600 text-white ml-auto' : 'bg-white text-slate-800 border border-slate-200 mr-auto';
        const statusIcon = isOut ? (m.status === 'SENT' ? '✓✓' : '...') : '';
        let mediaHtml = '';
        if (m.media_path) {
            const fileName = m.media_path.split(/[/\\]/).pop();
            const mediaUrl = `/uploads/media/${fileName}`;
            const isImage = /\.(jpg|jpeg|png|webp|gif)$/i.test(m.media_path);
            const isVideo = /\.(mp4|mov|avi|m4v|3gp)$/i.test(m.media_path);

            if (isImage) {
                mediaHtml = `
                    <div class="mb-1.5 overflow-hidden rounded-lg border border-black/10">
                        <img src="${mediaUrl}" alt="Attached Image" class="max-h-48 max-w-full rounded-lg object-cover cursor-pointer hover:opacity-95" onclick="window.open('${mediaUrl}', '_blank')" />
                    </div>
                `;
            } else if (isVideo) {
                mediaHtml = `
                    <div class="mb-1.5 py-1 px-2 rounded-md bg-black/15 flex items-center gap-1.5 text-[11px] font-semibold">
                        <i data-lucide="video" class="w-3.5 h-3.5 text-white"></i>
                        <span>Video Attached (Playable in WhatsApp)</span>
                    </div>
                `;
            } else {
                mediaHtml = `
                    <div class="mb-1.5 py-1 px-2 rounded-md bg-black/15 flex items-center gap-1.5 text-[11px] font-semibold">
                        <i data-lucide="paperclip" class="w-3.5 h-3.5 text-white"></i>
                        <span>File Attached</span>
                    </div>
                `;
            }
        }

        return `
            <div class="flex flex-col max-w-[85%] ${isOut ? 'ml-auto items-end' : 'mr-auto items-start'}">
                <div class="p-2.5 rounded-xl text-xs ${bubbleBg} shadow-2xs whitespace-pre-line leading-relaxed">
                    ${mediaHtml}
                    <div>${m.message || ''}</div>
                </div>
                <div class="text-[9px] text-slate-400 mt-0.5 px-1 flex items-center gap-1">
                    <span>${time}</span>
                    <span>${statusIcon}</span>
                </div>
            </div>
        `;
    }).join('');

    lucide.createIcons();
    container.scrollTop = container.scrollHeight;
}

function renderDrawerTimeline(activities) {
    const container = document.getElementById('drawer-timeline-list');
    if (activities.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-400 py-6 text-center">No timeline activity recorded.</p>`;
        return;
    }

    container.innerHTML = activities.map(a => {
        const time = new Date(a.created_at).toLocaleString();
        return `
            <div class="flex items-start gap-3 p-3 bg-white rounded-lg border border-slate-200">
                <div class="w-2 h-2 rounded-full bg-blue-600 mt-1.5 shrink-0"></div>
                <div>
                    <h5 class="font-bold text-xs text-slate-800">${a.title}</h5>
                    <p class="text-xs text-slate-600 mt-0.5">${a.description || ''}</p>
                    <span class="text-[10px] text-slate-400 mt-1 block">${time}</span>
                </div>
            </div>
        `;
    }).join('');
}

function applyDrawerTemplate(tplId) {
    if (!tplId) return;
    const tpl = templatesData.find(t => t.id == tplId);
    if (!tpl || !currentLeadData) return;

    const lead = currentLeadData.lead;
    let text = tpl.content
        .replace(/\{\{first_name\}\}/gi, lead.first_name || '')
        .replace(/\{\{last_name\}\}/gi, lead.last_name || '')
        .replace(/\{\{company\}\}/gi, lead.company || '')
        .replace(/\{\{phone\}\}/gi, lead.phone || '');

    document.getElementById('drawer-chat-input').value = text;
}

async function sendDrawerWhatsApp() {
    const text = document.getElementById('drawer-chat-input').value.trim();
    const mediaPath = uploadedMedia.drawer ? uploadedMedia.drawer.filePath : null;

    if ((!text && !mediaPath) || !activeLeadId || !currentLeadData) {
        showToast('Please type a message or attach an image/video.', 'error');
        return;
    }

    try {
        const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                leadId: activeLeadId,
                phone: currentLeadData.lead.phone,
                message: text,
                mediaPath
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Message added to WhatsApp sending queue!', 'success');
            document.getElementById('drawer-chat-input').value = '';
            clearMedia('drawer');
            // Refresh lead profile after brief moment
            setTimeout(() => openLeadProfile(activeLeadId), 1500);
        } else {
            showToast(data.error || 'Failed to send message', 'error');
        }
    } catch (e) {
        showToast('Error sending message: ' + e.message, 'error');
    }
}

async function saveLeadNote() {
    const note = document.getElementById('drawer-note-input').value.trim();
    if (!note || !activeLeadId) return;

    try {
        await fetch(`/api/leads/${activeLeadId}/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note })
        });
        document.getElementById('drawer-note-input').value = '';
        showToast('Note added to timeline.', 'success');
        openLeadProfile(activeLeadId);
    } catch (e) {
        showToast('Failed to add note: ' + e.message, 'error');
    }
}

async function saveLeadDetails() {
    if (!activeLeadId) return;
    const update = {
        stage: document.getElementById('drawer-edit-stage').value,
        priority: document.getElementById('drawer-edit-priority').value,
        email: document.getElementById('drawer-edit-email').value,
        phone: document.getElementById('drawer-edit-phone').value,
        company: document.getElementById('drawer-edit-company').value,
        score: parseInt(document.getElementById('drawer-edit-score').value) || 0,
        notes: document.getElementById('drawer-edit-notes').value
    };

    try {
        await fetch(`/api/leads/${activeLeadId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(update)
        });
        showToast('Lead details updated successfully!', 'success');
        loadLeads();
        openLeadProfile(activeLeadId);
    } catch (e) {
        showToast('Failed to update lead: ' + e.message, 'error');
    }
}

async function deleteCurrentLead() {
    if (!confirm('Are you sure you want to permanently delete this lead?')) return;
    try {
        await fetch(`/api/leads/${activeLeadId}`, { method: 'DELETE' });
        showToast('Lead deleted.', 'info');
        closeLeadDrawer();
        loadLeads();
    } catch (e) {
        showToast('Failed to delete lead: ' + e.message, 'error');
    }
}

async function deleteLeadDirect(id) {
    if (!confirm('Delete this lead?')) return;
    try {
        await fetch(`/api/leads/${id}`, { method: 'DELETE' });
        showToast('Lead deleted.', 'info');
        loadLeads();
    } catch (e) {
        showToast('Failed to delete lead: ' + e.message, 'error');
    }
}

// ==========================================
// ADD LEAD MODAL
// ==========================================
function openAddLeadModal() {
    document.getElementById('modal-add-lead').classList.remove('hidden');
}

function closeAddLeadModal() {
    document.getElementById('modal-add-lead').classList.add('hidden');
}

async function handleCreateLead(e) {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
    }

    const lead = {
        first_name: document.getElementById('add-lead-first').value.trim(),
        last_name: document.getElementById('add-lead-last').value.trim(),
        phone: document.getElementById('add-lead-phone').value.trim(),
        email: document.getElementById('add-lead-email').value.trim(),
        company: document.getElementById('add-lead-company').value.trim(),
        source: document.getElementById('add-lead-source').value,
        stage: document.getElementById('add-lead-stage').value,
        priority: document.getElementById('add-lead-priority').value,
        notes: document.getElementById('add-lead-notes').value.trim(),
        whatsapp_consent: document.getElementById('add-lead-consent')?.checked || false
    };

    try {
        const res = await fetch('/api/leads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(lead)
        });
        if (res.ok) {
            showToast(lead.whatsapp_consent ? 'Lead created & WhatsApp Consent (OPTED_IN) recorded!' : 'Lead created successfully!', 'success');
            e.target.reset();
            closeAddLeadModal();
            loadLeads();
        } else {
            const data = await res.json();
            showToast(data.error || 'Failed to create lead', 'error');
        }
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Lead';
        }
    }
}

// ==========================================
// CSV IMPORT & EXPORT
// ==========================================
async function handleCsvUpload(input) {
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);

    showToast('Importing CSV leads...', 'info');
    try {
        const res = await fetch('/api/leads/import', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Successfully imported ${data.imported} leads!`, 'success');
            loadLeads();
        } else {
            showToast(data.error || 'Import failed', 'error');
        }
    } catch (e) {
        showToast('Import error: ' + e.message, 'error');
    }
    input.value = '';
}

function exportLeadsCsv() {
    window.location.href = '/api/leads/export';
}

async function clearAllLeads() {
    if (!confirm('⚠️ Are you sure you want to delete ALL leads from the database?\n\nThis will remove all contact records, timeline activities, and queues. This action cannot be undone.')) {
        return;
    }
    try {
        const res = await fetch('/api/leads', { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast(data.message || 'All leads removed successfully.', 'success');
            loadLeads();
            loadDashboard();
        } else {
            showToast(data.error || 'Failed to clear leads.', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

// ==========================================
// WHATSAPP LOGS & DIRECT SEND
// ==========================================
async function loadWhatsAppLogs() {
    try {
        const res = await fetch('/api/whatsapp/logs');
        const logs = await res.json();
        const tbody = document.getElementById('wa-logs-tbody');

        if (logs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center py-6 text-slate-400">No transmission logs yet.</td></tr>`;
            return;
        }

        tbody.innerHTML = logs.map(l => {
            const time = new Date(l.created_at).toLocaleString();
            const isOut = l.direction === 'OUTGOING';
            const dirBadge = isOut ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700';
            const statusBadge = l.status === 'SENT' ? 'text-emerald-600 font-bold' : (l.status === 'FAILED' ? 'text-rose-600 font-bold' : 'text-slate-600');
            const leadName = l.first_name ? `${l.first_name} ${l.last_name || ''}` : l.phone;
            const isImg = /\.(jpg|jpeg|png|webp|gif)$/i.test(l.media_path || '');
            const mediaBadge = l.media_path ? (isImg ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 mr-1.5">🖼️ Image</span>' : '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 mr-1.5">🎬 Video</span>') : '';

            return `
                <tr class="hover:bg-slate-50">
                    <td class="py-2.5 px-4 text-slate-500">${time}</td>
                    <td class="py-2.5 px-4"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${dirBadge}">${l.direction}</span></td>
                    <td class="py-2.5 px-4 font-bold text-slate-800">${leadName}</td>
                    <td class="py-2.5 px-4 text-slate-600 truncate max-w-xs" title="${l.message}">${mediaBadge}${l.message || ''}</td>
                    <td class="py-2.5 px-4 ${statusBadge}">${l.status}</td>
                </tr>
            `;
        }).join('');
    } catch (e) {}
}

async function sendDirectWhatsApp() {
    const phone = document.getElementById('direct-wa-phone').value.trim();
    const message = document.getElementById('direct-wa-message').value.trim();
    const mediaPath = uploadedMedia.direct ? uploadedMedia.direct.filePath : null;

    if (!phone || (!message && !mediaPath)) {
        showToast('Phone number and either a message or media attachment are required.', 'error');
        return;
    }

    try {
        const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, message, mediaPath })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Message queued for safe delivery with anti-ban delay!', 'success');
            document.getElementById('direct-wa-message').value = '';
            clearMedia('direct');
            setTimeout(loadWhatsAppLogs, 2000);
        } else {
            showToast(data.error || 'Failed to send', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

function applyDirectTemplate(tplId) {
    if (!tplId) return;
    const tpl = templatesData.find(t => t.id == tplId);
    if (tpl) {
        document.getElementById('direct-wa-message').value = tpl.content;
    }
}

// ==========================================
// BROADCAST CAMPAIGNS
// ==========================================
let campaignsAutoRefreshTimer = null;

async function loadCampaigns() {
    try {
        const res = await fetch('/api/campaigns');
        const camps = await res.json();
        const tbody = document.getElementById('campaigns-tbody');

        if (camps.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-slate-400">No campaigns launched yet.</td></tr>`;
            return;
        }

        let hasActiveCampaign = false;

        tbody.innerHTML = camps.map(c => {
            const time = new Date(c.created_at).toLocaleDateString();
            let statusColor = 'text-blue-600 bg-blue-50';
            let statusLabel = c.status;

            if (c.status === 'Completed') statusColor = 'text-emerald-700 bg-emerald-50';
            else if (c.status === 'Failed') statusColor = 'text-rose-700 bg-rose-50';
            else if (c.status === 'Paused') statusColor = 'text-amber-700 bg-amber-50';
            
            let cooldownBadge = '';
            if (c.status === 'Running') {
                hasActiveCampaign = true;
                if (c.is_cooling_down && c.cooldown_seconds_remaining > 0) {
                    const mins = Math.floor(c.cooldown_seconds_remaining / 60);
                    const secs = c.cooldown_seconds_remaining % 60;
                    const timeStr = `${mins}m ${secs < 10 ? '0' : ''}${secs}s`;
                    statusColor = 'text-amber-800 bg-amber-100';
                    statusLabel = 'Cooling Down';
                    cooldownBadge = `
                        <div class="mt-1 flex items-center gap-1.5 flex-wrap">
                            <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-200/80 text-amber-900 animate-pulse">
                                ⏳ Rest Gap: ${timeStr}
                            </span>
                            <button onclick="skipCampaignCooldown(${c.id})" class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-100 hover:bg-blue-200 text-blue-800 border border-blue-300 transition-colors" title="Skip remaining cooldown and start next batch now">⚡ Resume Now</button>
                        </div>
                    `;
                }
            }
            
            const isImg = /\.(jpg|jpeg|png|webp|gif)$/i.test(c.media_path || '');
            const mediaTag = c.media_path ? (isImg ? '<span class="text-xs mr-1" title="Attached Image Media">🖼️</span>' : '<span class="text-xs mr-1" title="Attached Video Media">🎬</span>') : '';
            const retryBtn = (c.failed_count > 0 && c.status !== 'Running') 
                ? `<button onclick="retryCampaign(${c.id})" class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 shadow-2xs transition-all ml-1.5" title="Retry ${c.failed_count} failed message(s)">↻ Retry</button>` 
                : '';

            const batchInfo = (c.batch_size > 0 && c.batch_delay_minutes > 0)
                ? `<div class="text-[10px] text-slate-500 font-medium">Batch ${c.current_batch || 1} &bull; ${c.batch_size} leads/batch (${c.batch_delay_minutes}m gap)</div>`
                : '';

            return `
                <tr class="hover:bg-slate-50 transition-colors">
                    <td class="py-2.5 px-4 font-bold text-slate-800">
                        ${mediaTag}${c.name}
                        ${batchInfo}
                    </td>
                    <td class="py-2.5 px-4"><span class="px-2 py-0.5 rounded text-[10px] bg-slate-100 font-bold">${c.target_stage}</span></td>
                    <td class="py-2.5 px-4 text-slate-600">${c.template_name || 'Custom Message'}</td>
                    <td class="py-2.5 px-4 font-bold">
                        ${c.total_leads}
                        ${c.skipped_count > 0 ? `<div class="text-[10px] text-slate-400 font-normal font-sans">(${c.skipped_count} skipped: dupes/invalid)</div>` : ''}
                    </td>
                    <td class="py-2.5 px-4">
                        <span class="font-bold text-emerald-700">${c.sent_count} sent</span>
                        <span class="${c.failed_count > 0 ? 'text-rose-600 font-bold' : 'text-slate-400 text-[11px]'}">(${c.failed_count} failed)</span>
                    </td>
                    <td class="py-2.5 px-4">
                        <span class="px-2 py-0.5 rounded text-[10px] font-bold ${statusColor}">${statusLabel}</span>
                        ${c.error_message ? `<div class="text-[9px] text-rose-600 font-medium max-w-[180px] leading-tight mt-0.5" title="${c.error_message}">${c.error_message.length > 50 ? c.error_message.substring(0, 48) + '...' : c.error_message}</div>` : ''}
                        ${cooldownBadge}
                    </td>
                    <td class="py-2.5 px-4 text-slate-500 whitespace-nowrap">${time} ${retryBtn}</td>
                </tr>
            `;
        }).join('');

        // Auto-refresh when campaigns are actively running or cooling down
        if (hasActiveCampaign) {
            if (campaignsAutoRefreshTimer) clearTimeout(campaignsAutoRefreshTimer);
            campaignsAutoRefreshTimer = setTimeout(() => {
                const currentTab = document.querySelector('.nav-tab.active')?.getAttribute('data-tab');
                if (currentTab === 'campaigns') loadCampaigns();
            }, 3000);
        }
    } catch (e) {}
}

function togglePacingCustomInputs(mode) {
    const minBox = document.getElementById('custom-min-delay-box');
    const maxBox = document.getElementById('custom-max-delay-box');
    if (!minBox || !maxBox) return;
    if (mode === 'custom') {
        minBox.classList.remove('hidden');
        maxBox.classList.remove('hidden');
    } else {
        minBox.classList.add('hidden');
        maxBox.classList.add('hidden');
    }
}

function toggleBatchCustomInputs(val) {
    const box = document.getElementById('custom-batch-size-box');
    if (!box) return;
    if (val === 'custom') box.classList.remove('hidden');
    else box.classList.add('hidden');
}

function toggleBatchDelayCustomInputs(val) {
    const box = document.getElementById('custom-batch-delay-box');
    if (!box) return;
    if (val === 'custom') box.classList.remove('hidden');
    else box.classList.add('hidden');
}

async function skipCampaignCooldown(id) {
    try {
        const res = await fetch(`/api/campaigns/${id}/skip-cooldown`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('Cooldown skipped! Resuming message dispatch...', 'info');
            loadCampaigns();
        } else {
            showToast(data.error || 'Failed to skip cooldown', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

async function retryCampaign(id) {
    try {
        const res = await fetch(`/api/campaigns/${id}/retry`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(`Retrying ${data.retriedCount} failed message(s) with safe anti-ban pacing...`, 'info');
            loadCampaigns();
        } else {
            showToast(data.message || data.error || 'Failed to retry', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

function previewCampaignTemplate(tplId) {
    if (!tplId) return;
    const tpl = templatesData.find(t => t.id == tplId);
    if (tpl) {
        document.getElementById('camp-custom-msg').value = tpl.content;
    }
}

async function launchBroadcastCampaign() {
    const name = document.getElementById('camp-name').value.trim();
    const targetStage = document.getElementById('camp-stage-select').value;
    const templateId = document.getElementById('camp-template-select').value;
    const customMessage = document.getElementById('camp-custom-msg').value.trim();
    const mediaPath = uploadedMedia.camp ? uploadedMedia.camp.filePath : null;

    if (!customMessage && !templateId && !mediaPath) {
        showToast('Please specify a message, template, or attach an image/video.', 'error');
        return;
    }

    let minDelaySeconds = 60;
    let maxDelaySeconds = 120;
    const pacingMode = document.getElementById('camp-pacing-mode')?.value || 'safe';
    if (pacingMode === 'ultra') {
        minDelaySeconds = 120;
        maxDelaySeconds = 240;
    } else if (pacingMode === 'moderate') {
        minDelaySeconds = 30;
        maxDelaySeconds = 60;
    } else if (pacingMode === 'fast') {
        minDelaySeconds = 15;
        maxDelaySeconds = 30;
    } else if (pacingMode === 'turbo') {
        minDelaySeconds = 5;
        maxDelaySeconds = 12;
    } else if (pacingMode === 'custom') {
        minDelaySeconds = parseInt(document.getElementById('camp-min-delay')?.value) || 60;
        maxDelaySeconds = parseInt(document.getElementById('camp-max-delay')?.value) || 120;
    }

    let batchSize = 25;
    const batchSel = document.getElementById('camp-batch-size-select')?.value || '25';
    if (batchSel === 'custom') {
        batchSize = parseInt(document.getElementById('camp-custom-batch-size')?.value) || 25;
    } else {
        batchSize = parseInt(batchSel);
    }

    let batchDelayMinutes = 10;
    const delaySel = document.getElementById('camp-batch-delay-select')?.value || '10';
    if (delaySel === 'custom') {
        batchDelayMinutes = parseInt(document.getElementById('camp-custom-batch-delay')?.value) || 10;
    } else {
        batchDelayMinutes = parseInt(delaySel);
    }

    const batchSummary = (batchSize > 0 && batchDelayMinutes > 0)
        ? `\n\n🛡️ Batching Shield: Sends ${batchSize} messages per batch, then takes a ${batchDelayMinutes}-minute gap before sending the next ${batchSize} messages.`
        : `\n\nContinuous Mode: No batch rest gaps.`;

    if (!confirm(`Are you sure you want to broadcast to leads in stage '${targetStage}'?\n\nAnti-Ban Safety:\n• Pacing: ${minDelaySeconds}s - ${maxDelaySeconds}s randomized delay per message.${batchSummary}\n\nThis shields your WhatsApp account from spam restrictions.`)) return;

    try {
        const res = await fetch('/api/campaigns/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                targetStage,
                templateId,
                customMessage,
                mediaPath,
                minDelaySeconds,
                maxDelaySeconds,
                batchSize,
                batchDelayMinutes
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, 'success');
            clearMedia('camp');
            loadCampaigns();
        } else {
            showToast(data.error || 'Failed to start campaign', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

// ==========================================
// AUTOMATION WORKFLOWS
// ==========================================
async function loadAutomations() {
    try {
        const res = await fetch('/api/automations');
        const autos = await res.json();
        const grid = document.getElementById('automations-grid');

        if (autos.length === 0) {
            grid.innerHTML = `<p class="col-span-3 text-center py-10 text-slate-400">No automation rules created yet.</p>`;
            return;
        }

        grid.innerHTML = autos.map(a => {
            const isChecked = a.is_active ? 'checked' : '';
            const triggerText = a.trigger_type === 'ON_LEAD_CREATED' ? 'New Lead Created' : `Stage Changed to '${a.trigger_condition}'`;

            return `
                <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between">
                    <div>
                        <div class="flex items-center justify-between mb-3">
                            <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700">Trigger: ${triggerText}</span>
                            <label class="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" ${isChecked} onchange="toggleAutomation(${a.id})" class="sr-only peer">
                                <div class="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                            </label>
                        </div>
                        <h4 class="font-bold text-sm text-slate-900">${a.name}</h4>
                        <div class="mt-2.5 p-2 bg-slate-50 rounded text-xs text-slate-600 border border-slate-100">
                            <span class="font-semibold text-slate-700">Action:</span> Send WhatsApp Template <b>"${a.template_name || 'Custom'}"</b>
                        </div>
                    </div>
                    <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                        <span class="text-[10px] text-slate-400">Rule #${a.id}</span>
                        <button onclick="deleteAutomation(${a.id})" class="text-xs text-rose-600 hover:text-rose-800 font-semibold flex items-center gap-1">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Delete
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        lucide.createIcons();
    } catch (e) {}
}

async function toggleAutomation(id) {
    try {
        await fetch(`/api/automations/${id}/toggle`, { method: 'PUT' });
        showToast('Automation status updated.', 'success');
    } catch (e) {
        showToast('Failed to toggle automation: ' + e.message, 'error');
    }
}

async function deleteAutomation(id) {
    if (!confirm('Delete this automation rule?')) return;
    try {
        await fetch(`/api/automations/${id}`, { method: 'DELETE' });
        showToast('Automation rule deleted.', 'info');
        loadAutomations();
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

function openAddAutomationModal() {
    const select = document.getElementById('auto-template-id');
    select.innerHTML = templatesData.map(t => `<option value="${t.id}">${t.name} (${t.category})</option>`).join('');
    document.getElementById('modal-add-automation').classList.remove('hidden');
}

function closeAddAutomationModal() {
    document.getElementById('modal-add-automation').classList.add('hidden');
}

async function handleCreateAutomation(e) {
    e.preventDefault();
    const auto = {
        name: document.getElementById('auto-name').value.trim(),
        trigger_type: document.getElementById('auto-trigger-type').value,
        trigger_condition: document.getElementById('auto-condition').value,
        template_id: document.getElementById('auto-template-id').value
    };

    try {
        const res = await fetch('/api/automations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(auto)
        });
        if (res.ok) {
            showToast('Automation workflow created!', 'success');
            closeAddAutomationModal();
            loadAutomations();
        } else {
            const data = await res.json();
            showToast(data.error || 'Failed to create automation', 'error');
        }
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    }
}

// ==========================================
// MESSAGE TEMPLATES
// ==========================================
async function loadTemplates() {
    try {
        const res = await fetch('/api/templates');
        templatesData = await res.json();

        // Populate selects
        const directSelect = document.getElementById('direct-wa-template-select');
        const campSelect = document.getElementById('camp-template-select');

        const optionsHtml = `<option value="">-- Choose Template --</option>` +
            templatesData.map(t => `<option value="${t.id}">${t.name} (${t.category})</option>`).join('');

        if (directSelect) directSelect.innerHTML = optionsHtml;
        if (campSelect) campSelect.innerHTML = optionsHtml;

        // Render templates grid
        const grid = document.getElementById('templates-grid');
        if (!grid) return;

        if (templatesData.length === 0) {
            grid.innerHTML = `<p class="col-span-3 text-center py-10 text-slate-400">No templates created yet.</p>`;
            return;
        }

        grid.innerHTML = templatesData.map(t => {
            return `
                <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between">
                    <div>
                        <div class="flex items-center justify-between mb-2">
                            <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">${t.category}</span>
                            <button onclick="deleteTemplate(${t.id})" class="text-slate-400 hover:text-rose-600"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                        </div>
                        <h4 class="font-bold text-sm text-slate-900 mb-2">${t.name}</h4>
                        <div class="p-3 bg-slate-50 rounded-lg border border-slate-100 text-xs text-slate-700 whitespace-pre-line leading-relaxed font-sans">
                            ${t.content}
                        </div>
                    </div>
                    <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
                        <span>Merge tags supported</span>
                        <button onclick="useTemplateInDirectSender('${t.id}')" class="text-blue-600 font-semibold hover:underline">Use &rarr;</button>
                    </div>
                </div>
            `;
        }).join('');

        lucide.createIcons();
    } catch (e) {}
}

function useTemplateInDirectSender(id) {
    switchTab('whatsapp');
    applyDirectTemplate(id);
    document.getElementById('direct-wa-template-select').value = id;
}

function openAddTemplateModal() {
    document.getElementById('modal-add-template').classList.remove('hidden');
}

function closeAddTemplateModal() {
    document.getElementById('modal-add-template').classList.add('hidden');
}

async function handleCreateTemplate(e) {
    e.preventDefault();
    const tpl = {
        name: document.getElementById('tpl-name').value.trim(),
        category: document.getElementById('tpl-category').value,
        content: document.getElementById('tpl-content').value.trim()
    };

    try {
        const res = await fetch('/api/templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tpl)
        });
        if (res.ok) {
            showToast('Template created successfully!', 'success');
            closeAddTemplateModal();
            loadTemplates();
        } else {
            const data = await res.json();
            showToast(data.error || 'Failed to create template', 'error');
        }
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    }
}

async function deleteTemplate(id) {
    if (!confirm('Delete this template?')) return;
    try {
        await fetch(`/api/templates/${id}`, { method: 'DELETE' });
        showToast('Template deleted.', 'info');
        loadTemplates();
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

function insertVariable(targetId, variableTag) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const start = el.selectionStart || el.value.length;
    const end = el.selectionEnd || el.value.length;
    el.value = el.value.substring(0, start) + variableTag + el.value.substring(end);
    el.focus();
}

function switchPairingTab(tab) {
    const btnQr = document.getElementById('tab-btn-qr');
    const btnPhone = document.getElementById('tab-btn-phone');
    const panelQr = document.getElementById('pairing-panel-qr');
    const panelPhone = document.getElementById('pairing-panel-phone');

    if (tab === 'phone') {
        if (btnQr) {
            btnQr.className = 'px-3 py-1.5 rounded-md text-xs font-medium text-slate-500 hover:text-slate-800 transition-all';
        }
        if (btnPhone) {
            btnPhone.className = 'px-3 py-1.5 rounded-md text-xs font-bold transition-all bg-white text-slate-800 shadow-xs';
        }
        if (panelQr) panelQr.classList.add('hidden');
        if (panelPhone) panelPhone.classList.remove('hidden');
    } else {
        if (btnQr) {
            btnQr.className = 'px-3 py-1.5 rounded-md text-xs font-bold transition-all bg-white text-slate-800 shadow-xs';
        }
        if (btnPhone) {
            btnPhone.className = 'px-3 py-1.5 rounded-md text-xs font-medium text-slate-500 hover:text-slate-800 transition-all';
        }
        if (panelQr) panelQr.classList.remove('hidden');
        if (panelPhone) panelPhone.classList.add('hidden');
    }
    if (window.lucide) lucide.createIcons();
}

async function refreshPairingState() {
    showToast('Refreshing pairing status...', 'info');
    await checkWhatsAppStatus();
}

async function forceResetWhatsAppSession() {
    if (!confirm('This will terminate any stuck browser locks and restart the WhatsApp engine with a fresh QR code. Continue?')) return;
    showToast('Clearing browser locks and regenerating WhatsApp session...', 'info');
    try {
        const res = await fetch('/api/whatsapp/reset', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(data.message || 'WhatsApp session reset. Generating fresh QR code...', 'success');
            setTimeout(checkWhatsAppStatus, 1500);
        } else {
            showToast(data.error || 'Reset failed', 'error');
        }
    } catch (e) {
        showToast('Error resetting: ' + e.message, 'error');
    }
}

async function requestPhonePairingCode() {
    const input = document.getElementById('pairing-phone-input');
    const btn = document.getElementById('btn-request-pairing-code');
    const displayBox = document.getElementById('pairing-code-display-box');
    const digitsEl = document.getElementById('pairing-code-digits');

    const rawPhone = input ? input.value.trim() : '';
    const cleanPhone = rawPhone.replace(/\D/g, '');

    if (!cleanPhone || cleanPhone.length < 8) {
        showToast('Please enter a valid phone number with country code (e.g. 919876543210)', 'error');
        if (input) input.focus();
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader" class="w-3.5 h-3.5 animate-spin inline mr-1"></i><span>Requesting...</span>`;
        if (window.lucide) lucide.createIcons();
    }

    try {
        const res = await fetch('/api/openwa/pairing-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber: cleanPhone })
        });
        const data = await res.json();

        if (data.success && data.pairingCode) {
            const rawCode = data.pairingCode;
            const formatted = rawCode.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode;
            if (digitsEl) digitsEl.textContent = formatted;
            if (displayBox) displayBox.classList.remove('hidden');
            showToast('Pairing code generated! Enter it on your phone.', 'success');
        } else {
            showToast(data.error || 'Failed to generate pairing code. Please try QR scan instead.', 'error');
        }
    } catch (err) {
        showToast('Pairing code error: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i data-lucide="key" class="w-3.5 h-3.5 inline mr-1"></i><span>Get 8-Digit Code</span>`;
            if (window.lucide) lucide.createIcons();
        }
    }
}

// ============================================================================
// WHATSAPP COMPLIANCE & MESSAGING GUARD CLIENT CONTROLLERS
// ============================================================================
let currentComplianceRole = 'ADMIN';
let currentComplianceSubTab = 'consents';
let complianceSearchDebounceTimer = null;

function getComplianceHeaders() {
    return {
        'Content-Type': 'application/json',
        'x-user-role': currentComplianceRole,
        'x-role': currentComplianceRole,
        'x-user-id': 'agent_ui_1',
        'x-tenant-id': 'default'
    };
}

function changeComplianceRole(role) {
    currentComplianceRole = role;
    const select = document.getElementById('comp-role-select');
    if (select && select.value !== role) select.value = role;
    showToast(`Active compliance role set to: ${role}`, 'info');
    loadComplianceDashboard();
}

function switchComplianceSubTab(subTab) {
    currentComplianceSubTab = subTab;
    const tabs = ['consents', 'suppressions', 'audit', 'settings'];

    tabs.forEach(t => {
        const btn = document.getElementById(`comp-subtab-btn-${t}`);
        const view = document.getElementById(`comp-subview-${t}`);

        if (t === subTab) {
            if (btn) btn.className = 'comp-subtab-btn py-3 px-3 border-b-2 border-blue-600 text-blue-600 font-bold text-xs flex items-center gap-1.5';
            if (view) view.classList.remove('hidden');
        } else {
            if (btn) btn.className = 'comp-subtab-btn py-3 px-3 border-b-2 border-transparent text-slate-500 hover:text-slate-800 font-semibold text-xs flex items-center gap-1.5';
            if (view) view.classList.add('hidden');
        }
    });

    if (subTab === 'consents') loadConsentsRegistry();
    else if (subTab === 'suppressions') loadSuppressionsList();
    else if (subTab === 'audit') loadAuditLogs();
    else if (subTab === 'settings') loadComplianceSettings();

    if (window.lucide) lucide.createIcons();
}

async function loadComplianceDashboard() {
    try {
        const res = await fetch('/api/compliance/stats', {
            headers: getComplianceHeaders()
        });
        const data = await res.json();

        if (data.success) {
            const elConsents = document.getElementById('comp-kpi-consents');
            const elSupp = document.getElementById('comp-kpi-suppressions');
            const elBlocked = document.getElementById('comp-kpi-blocked');
            const elApproved = document.getElementById('comp-kpi-approved');

            if (elConsents) elConsents.textContent = (data.activeOptedIn || 0).toLocaleString();
            if (elSupp) elSupp.textContent = (data.suppressedContacts || 0).toLocaleString();
            if (elBlocked) elBlocked.textContent = (data.blockedDispatches || 0).toLocaleString();
            if (elApproved) elApproved.textContent = (data.approvedDispatches || 0).toLocaleString();
        }

        // Fetch registered business settings for banner
        const setRes = await fetch('/api/compliance/settings', {
            headers: getComplianceHeaders()
        });
        const setData = await setRes.json();
        if (setData.success && setData.settings) {
            const bizNameEl = document.getElementById('consent-modal-biz-name');
            if (bizNameEl) bizNameEl.textContent = setData.settings.business_name || 'Jai Shree Krishna products and services';
        }

        switchComplianceSubTab(currentComplianceSubTab || 'consents');
    } catch (err) {
        console.error('Error loading compliance dashboard:', err);
    }
}

async function loadConsentsRegistry() {
    const tbody = document.getElementById('comp-consents-tbody');
    const totalLabel = document.getElementById('comp-consents-total-label');
    const searchVal = document.getElementById('comp-consent-search')?.value.trim() || '';
    const purposeVal = document.getElementById('comp-consent-purpose-filter')?.value || '';
    const statusVal = document.getElementById('comp-consent-status-filter')?.value || '';

    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-slate-400"><i data-lucide="loader" class="w-4 h-4 animate-spin inline mr-1 text-blue-600"></i>Loading consent records...</td></tr>`;
        if (window.lucide) lucide.createIcons();
    }

    try {
        const queryParams = new URLSearchParams();
        if (searchVal) queryParams.set('search', searchVal);
        if (purposeVal) queryParams.set('purpose', purposeVal);
        if (statusVal) queryParams.set('status', statusVal);

        const res = await fetch(`/api/compliance/consents?${queryParams.toString()}`, {
            headers: getComplianceHeaders()
        });
        const data = await res.json();

        if (!data.success) {
            if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-rose-500 font-medium">Failed to load consents: ${data.error}</td></tr>`;
            return;
        }

        const consents = data.consents || [];
        if (totalLabel) totalLabel.textContent = `Showing ${consents.length} of ${data.total || consents.length} record(s)`;

        if (consents.length === 0) {
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" class="text-center py-10 text-slate-400">
                            <div class="max-w-xs mx-auto space-y-2">
                                <i data-lucide="shield-alert" class="w-8 h-8 text-slate-300 mx-auto"></i>
                                <p class="font-bold text-slate-600">No WhatsApp Consents Found</p>
                                <p class="text-[11px] text-slate-400">Capture verifiable affirmative opt-ins before sending marketing broadcasts.</p>
                                <button onclick="openCaptureConsentModal()" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs inline-flex items-center gap-1">
                                    <i data-lucide="plus-circle" class="w-3.5 h-3.5"></i> Capture First Consent
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
                if (window.lucide) lucide.createIcons();
            }
            return;
        }

        if (tbody) {
            tbody.innerHTML = consents.map(c => {
                let statusBadge = '';
                if (c.status === 'OPTED_IN') statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">OPTED_IN</span>';
                else if (c.status === 'REVOKED') statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-200">REVOKED</span>';
                else if (c.status === 'EXPIRED') statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">EXPIRED</span>';
                else statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">${c.status}</span>`;

                let purposeBadge = '';
                if (c.purpose === 'MARKETING') purposeBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">MARKETING</span>';
                else if (c.purpose === 'TRANSACTIONAL') purposeBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">TRANSACTIONAL</span>';
                else purposeBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">${c.purpose}</span>`;

                const leadName = c.first_name ? `${c.first_name} ${c.last_name || ''}`.trim() : '<span class="text-slate-400 italic">Unlinked</span>';
                const evidenceText = c.consent_evidence ? c.consent_evidence : '<span class="text-slate-300">-</span>';

                const canRevoke = c.status === 'OPTED_IN';
                const revokeBtn = canRevoke
                    ? `<button onclick="handleRevokeConsent('${c.contact_phone}', '${c.purpose}')" class="px-2 py-1 text-rose-600 hover:bg-rose-50 rounded font-bold text-[11px] transition-colors" title="Revoke Consent">Revoke</button>`
                    : '';

                return `
                    <tr class="hover:bg-slate-50 transition-colors">
                        <td class="py-2.5 px-3 font-mono font-bold text-slate-900">${c.contact_phone}</td>
                        <td class="py-2.5 px-3 text-slate-800 font-medium">${leadName}</td>
                        <td class="py-2.5 px-3">${purposeBadge}</td>
                        <td class="py-2.5 px-3">${statusBadge}</td>
                        <td class="py-2.5 px-3 text-slate-600">
                            <span class="font-bold text-slate-800">${c.collection_method || 'WEB_FORM'}</span>
                            <div class="text-[10px] text-slate-400">${c.source || 'CRM'}</div>
                        </td>
                        <td class="py-2.5 px-3 text-slate-600 max-w-xs truncate" title="${c.consent_evidence || ''}">${evidenceText}</td>
                        <td class="py-2.5 px-3 text-right whitespace-nowrap space-x-1">
                            <button onclick="openConsentHistoryModal('${c.contact_phone}')" class="px-2 py-1 text-blue-600 hover:bg-blue-50 rounded font-bold text-[11px] transition-colors" title="View Audit Trail">History</button>
                            ${revokeBtn}
                        </td>
                    </tr>
                `;
            }).join('');
            if (window.lucide) lucide.createIcons();
        }
    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-rose-500 font-medium">Error loading consents: ${err.message}</td></tr>`;
    }
}

function filterConsentsTable() {
    if (complianceSearchDebounceTimer) clearTimeout(complianceSearchDebounceTimer);
    complianceSearchDebounceTimer = setTimeout(() => {
        loadConsentsRegistry();
    }, 350);
}

async function loadSuppressionsList() {
    const tbody = document.getElementById('comp-suppressions-tbody');
    const totalLabel = document.getElementById('comp-suppressions-total-label');
    const searchVal = document.getElementById('comp-suppression-search')?.value.trim() || '';

    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-slate-400"><i data-lucide="loader" class="w-4 h-4 animate-spin inline mr-1 text-rose-600"></i>Loading suppression records...</td></tr>`;
        if (window.lucide) lucide.createIcons();
    }

    try {
        const queryParams = new URLSearchParams();
        if (searchVal) queryParams.set('search', searchVal);

        const res = await fetch(`/api/compliance/suppressions?${queryParams.toString()}`, {
            headers: getComplianceHeaders()
        });
        const data = await res.json();

        if (!data.success) {
            if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-rose-500 font-medium">Failed to load suppression list: ${data.error}</td></tr>`;
            return;
        }

        const items = data.suppressions || [];
        if (totalLabel) totalLabel.textContent = `Showing ${items.length} of ${data.total || items.length} suppressed contact(s)`;

        if (items.length === 0) {
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" class="text-center py-10 text-slate-400">
                            <div class="max-w-xs mx-auto space-y-1.5">
                                <i data-lucide="user-check" class="w-8 h-8 text-emerald-400 mx-auto"></i>
                                <p class="font-bold text-slate-600">Suppression List is Empty</p>
                                <p class="text-[11px] text-slate-400">No contacts currently opted out or suppressed.</p>
                            </div>
                        </td>
                    </tr>
                `;
                if (window.lucide) lucide.createIcons();
            }
            return;
        }

        if (tbody) {
            tbody.innerHTML = items.map(s => {
                const dateStr = s.created_at ? new Date(s.created_at).toLocaleString() : '-';
                const scopeBadge = s.scope === 'GLOBAL'
                    ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-200">GLOBAL</span>'
                    : '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">MARKETING</span>';

                let reasonBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-800">${s.reason}</span>`;
                if (s.reason === 'KEYWORD_STOP') {
                    reasonBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">INBOUND STOP KEYWORD</span>';
                } else if (s.reason === 'USER_OPT_OUT') {
                    reasonBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">USER OPT-OUT</span>';
                }

                return `
                    <tr class="hover:bg-slate-50 transition-colors">
                        <td class="py-2.5 px-3 font-mono font-bold text-slate-900">${s.phone}</td>
                        <td class="py-2.5 px-3">${reasonBadge}</td>
                        <td class="py-2.5 px-3">${scopeBadge}</td>
                        <td class="py-2.5 px-3 text-slate-600">
                            <span class="font-bold text-slate-800">${s.actor_id || 'system'}</span>
                            <span class="text-[10px] text-slate-400">(${s.actor_role || 'SYSTEM'})</span>
                        </td>
                        <td class="py-2.5 px-3 text-slate-500 whitespace-nowrap text-[11px]">${dateStr}</td>
                        <td class="py-2.5 px-3 text-slate-600 max-w-xs truncate" title="${s.evidence || ''}">${s.evidence || '<span class="text-slate-300">-</span>'}</td>
                        <td class="py-2.5 px-3 text-right">
                            <button onclick="handleRemoveSuppression('${s.phone}', '${s.scope}')" class="px-2 py-1 text-slate-600 hover:text-rose-600 hover:bg-rose-50 rounded font-bold text-[11px] transition-colors" title="Remove Suppression">
                                Remove
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');
            if (window.lucide) lucide.createIcons();
        }
    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-rose-500 font-medium">Error loading suppressions: ${err.message}</td></tr>`;
    }
}

async function loadAuditLogs() {
    const tbody = document.getElementById('comp-audit-tbody');
    const searchVal = document.getElementById('comp-audit-search')?.value.trim() || '';
    const actionVal = document.getElementById('comp-audit-action-filter')?.value || '';

    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-slate-400"><i data-lucide="loader" class="w-4 h-4 animate-spin inline mr-1 text-blue-600"></i>Loading compliance audit stream...</td></tr>`;
        if (window.lucide) lucide.createIcons();
    }

    try {
        const queryParams = new URLSearchParams();
        if (searchVal) queryParams.set('search', searchVal);
        if (actionVal) queryParams.set('action', actionVal);

        const res = await fetch(`/api/compliance/audit-logs?${queryParams.toString()}`, {
            headers: getComplianceHeaders()
        });
        const data = await res.json();

        if (!data.success) {
            if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-rose-500 font-medium">Failed to load audit logs: ${data.error}</td></tr>`;
            return;
        }

        const logs = data.logs || [];
        if (logs.length === 0) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-400">No audit log entries matching filters.</td></tr>`;
            }
            return;
        }

        if (tbody) {
            tbody.innerHTML = logs.map(l => {
                const dateStr = l.created_at ? new Date(l.created_at).toLocaleString() : '-';

                let actionBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">${l.action}</span>`;
                if (l.action === 'DISPATCH_APPROVED') actionBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">DISPATCH_APPROVED</span>';
                else if (l.action === 'DISPATCH_BLOCKED') actionBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-200">DISPATCH_BLOCKED</span>';
                else if (l.action === 'CONSENT_CAPTURED') actionBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-200">CONSENT_CAPTURED</span>';
                else if (l.action === 'CONSENT_REVOKED') actionBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">CONSENT_REVOKED</span>';
                else if (l.action === 'SUPPRESSION_ADDED') actionBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">SUPPRESSION_ADDED</span>';
                else if (l.action === 'SUPPRESSION_REMOVED') actionBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-sky-50 text-sky-700 border border-sky-200">SUPPRESSION_REMOVED</span>';

                let statusBadge = `<span class="font-bold text-[10px] text-slate-600">${l.status || 'INFO'}</span>`;
                if (l.status === 'ALLOWED' || l.status === 'SUCCESS') statusBadge = '<span class="text-emerald-600 font-bold text-[10px]">SUCCESS</span>';
                else if (l.status === 'BLOCKED' || l.status === 'DENIED') statusBadge = '<span class="text-rose-600 font-bold text-[10px]">BLOCKED</span>';

                let detailStr = l.reason || '';
                if (l.metadata) {
                    try {
                        const parsed = typeof l.metadata === 'string' ? JSON.parse(l.metadata) : l.metadata;
                        if (parsed && typeof parsed === 'object') {
                            const metaPreview = Object.entries(parsed).map(([k, v]) => `${k}: ${v}`).join(', ');
                            detailStr += detailStr ? ` (${metaPreview})` : metaPreview;
                        }
                    } catch (e) {}
                }

                return `
                    <tr class="hover:bg-slate-50 transition-colors">
                        <td class="py-2.5 px-3 text-slate-500 whitespace-nowrap text-[11px] font-mono">${dateStr}</td>
                        <td class="py-2.5 px-3">${actionBadge}</td>
                        <td class="py-2.5 px-3 font-mono font-bold text-slate-800">${l.entity_id || l.entity_type || '-'}</td>
                        <td class="py-2.5 px-3 text-slate-700">
                            <span class="font-semibold">${l.actor_id || 'system'}</span>
                            <span class="text-[10px] text-slate-400">[${l.actor_role || 'SYSTEM'}]</span>
                        </td>
                        <td class="py-2.5 px-3">${statusBadge}</td>
                        <td class="py-2.5 px-3 text-slate-600 max-w-sm truncate" title="${detailStr}">${detailStr || '<span class="text-slate-300">-</span>'}</td>
                    </tr>
                `;
            }).join('');
            if (window.lucide) lucide.createIcons();
        }
    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-rose-500 font-medium">Error loading audit logs: ${err.message}</td></tr>`;
    }
}

async function loadComplianceSettings() {
    try {
        const res = await fetch('/api/compliance/settings', {
            headers: getComplianceHeaders()
        });
        const data = await res.json();

        if (data.success && data.settings) {
            const s = data.settings;
            const bizEl = document.getElementById('comp-settings-business-name');
            const kwEl = document.getElementById('comp-settings-keywords');
            const footEl = document.getElementById('comp-settings-footer');
            const winEl = document.getElementById('comp-settings-enforce-24h');
            const consentEl = document.getElementById('comp-settings-enforce-consent');
            const previewCodeEl = document.getElementById('camp-footer-preview-code');

            const footerVal = s.opt_out_footer_text || s.mandatory_opt_out_footer || 'Reply STOP to unsubscribe.';
            if (bizEl) bizEl.value = s.business_name || 'Jai Shree Krishna products and services';
            if (kwEl) {
                const kwList = Array.isArray(s.opt_out_keywords) ? s.opt_out_keywords.join(', ') : (s.opt_out_keywords || '');
                kwEl.value = kwList;
            }
            if (footEl) footEl.value = footerVal;
            if (previewCodeEl) previewCodeEl.textContent = footerVal;
            if (winEl) winEl.checked = Boolean(s.enforce_24h_window);
            if (consentEl) consentEl.checked = s.enforce_marketing_consent !== undefined ? Boolean(s.enforce_marketing_consent) : true;
        }
    } catch (err) {
        showToast('Failed to load guard policy settings: ' + err.message, 'error');
    }
}

async function handleSaveComplianceSettings(e) {
    e.preventDefault();

    const rawKeywords = document.getElementById('comp-settings-keywords')?.value || '';
    const keywords = rawKeywords.split(',').map(k => k.trim().toUpperCase()).filter(k => k.length > 0);
    const footerVal = document.getElementById('comp-settings-footer')?.value.trim() || 'Reply STOP to unsubscribe.';

    const payload = {
        business_name: document.getElementById('comp-settings-business-name')?.value.trim(),
        opt_out_keywords: keywords,
        opt_out_footer_text: footerVal,
        mandatory_opt_out_footer: footerVal,
        enforce_24h_window: document.getElementById('comp-settings-enforce-24h')?.checked,
        enforce_marketing_consent: document.getElementById('comp-settings-enforce-consent')?.checked
    };

    try {
        const res = await fetch('/api/compliance/settings', {
            method: 'POST',
            headers: getComplianceHeaders(),
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.success) {
            const previewCodeEl = document.getElementById('camp-footer-preview-code');
            if (previewCodeEl) previewCodeEl.textContent = footerVal;
            showToast('Compliance guard policies saved successfully!', 'success');
            loadComplianceDashboard();
        } else {
            showToast(data.error || 'Failed to save settings', 'error');
        }
    } catch (err) {
        showToast('Settings error: ' + err.message, 'error');
    }
}

// Modal Handlers: Consent Capture
function openCaptureConsentModal(prefillPhone = '') {
    const phoneInput = document.getElementById('consent-phone');
    const affCheck = document.getElementById('consent-affirmative-check');
    const evidenceInput = document.getElementById('consent-evidence');

    if (phoneInput && prefillPhone) phoneInput.value = prefillPhone;
    if (affCheck) affCheck.checked = false; // Affirmative action MUST be unchecked by default
    if (evidenceInput && !prefillPhone) evidenceInput.value = '';

    const modal = document.getElementById('modal-capture-consent');
    if (modal) modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

function closeCaptureConsentModal() {
    const modal = document.getElementById('modal-capture-consent');
    if (modal) modal.classList.add('hidden');
}

async function handleCaptureConsentSubmit(e) {
    e.preventDefault();

    const check = document.getElementById('consent-affirmative-check');
    if (!check || !check.checked) {
        showToast('Affirmative user action is mandatory! Inferred consent is strictly prohibited.', 'error');
        return;
    }

    const payload = {
        phone: document.getElementById('consent-phone').value.trim(),
        purpose: document.getElementById('consent-purpose').value,
        collectionMethod: document.getElementById('consent-method').value,
        consentEvidence: document.getElementById('consent-evidence').value.trim(),
        status: 'OPTED_IN',
        source: 'CRM_MANUAL_CAPTURE'
    };

    try {
        const res = await fetch('/api/compliance/consents/capture', {
            method: 'POST',
            headers: getComplianceHeaders(),
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.success) {
            showToast('Affirmative WhatsApp consent captured and recorded!', 'success');
            closeCaptureConsentModal();
            loadComplianceDashboard();
            loadLeads();
        } else {
            showToast(data.error || 'Failed to capture consent', 'error');
        }
    } catch (err) {
        showToast('Consent capture error: ' + err.message, 'error');
    }
}

async function handleRevokeConsent(phone, purpose) {
    if (!confirm(`Are you sure you want to revoke ${purpose} WhatsApp consent for ${phone}?`)) return;

    try {
        const res = await fetch('/api/compliance/consents/revoke', {
            method: 'POST',
            headers: getComplianceHeaders(),
            body: JSON.stringify({
                phone,
                purpose,
                reason: 'Revoked via Compliance Console'
            })
        });
        const data = await res.json();

        if (data.success) {
            showToast(`Consent revoked for ${phone}. Subsequent dispatches are blocked.`, 'info');
            loadComplianceDashboard();
        } else {
            showToast(data.error || 'Failed to revoke consent', 'error');
        }
    } catch (err) {
        showToast('Error revoking consent: ' + err.message, 'error');
    }
}

// Modal Handlers: Suppression
function openAddSuppressionModal(prefillPhone = '') {
    const phoneInput = document.getElementById('suppress-phone');
    const evidenceInput = document.getElementById('suppress-evidence');

    if (phoneInput && prefillPhone) phoneInput.value = prefillPhone;
    if (evidenceInput && !prefillPhone) evidenceInput.value = '';

    const modal = document.getElementById('modal-add-suppression');
    if (modal) modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

function closeAddSuppressionModal() {
    const modal = document.getElementById('modal-add-suppression');
    if (modal) modal.classList.add('hidden');
}

async function handleAddSuppressionSubmit(e) {
    e.preventDefault();

    const payload = {
        phone: document.getElementById('suppress-phone').value.trim(),
        scope: document.getElementById('suppress-scope').value,
        reason: document.getElementById('suppress-reason').value,
        evidence: document.getElementById('suppress-evidence').value.trim()
    };

    try {
        const res = await fetch('/api/compliance/suppressions', {
            method: 'POST',
            headers: getComplianceHeaders(),
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.success) {
            showToast('Number added to suppression list! Any queued marketing messages canceled.', 'success');
            closeAddSuppressionModal();
            loadComplianceDashboard();
        } else {
            showToast(data.error || 'Failed to suppress number', 'error');
        }
    } catch (err) {
        showToast('Suppression error: ' + err.message, 'error');
    }
}

async function handleRemoveSuppression(phone, scope) {
    if (!confirm(`Are you sure you want to remove ${phone} from ${scope} suppression?`)) return;

    try {
        const res = await fetch(`/api/compliance/suppressions?phone=${encodeURIComponent(phone)}&scope=${encodeURIComponent(scope)}`, {
            method: 'DELETE',
            headers: getComplianceHeaders()
        });
        const data = await res.json();

        if (data.success) {
            showToast(`Suppression removed for ${phone}.`, 'info');
            loadComplianceDashboard();
        } else {
            showToast(data.error || 'Failed to remove suppression', 'error');
        }
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    }
}

// Modal Handlers: Contact Consent History
async function openConsentHistoryModal(phone) {
    const modal = document.getElementById('modal-consent-history');
    const badge = document.getElementById('history-phone-badge');
    const container = document.getElementById('history-timeline-container');

    if (badge) badge.textContent = phone;
    if (container) {
        container.innerHTML = `<div class="py-8 text-center text-slate-400"><i data-lucide="loader" class="w-5 h-5 animate-spin mx-auto mb-2 text-blue-600"></i>Loading compliance history...</div>`;
    }
    if (modal) modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();

    try {
        const res = await fetch(`/api/compliance/consents/history?phone=${encodeURIComponent(phone)}`, {
            headers: getComplianceHeaders()
        });
        const data = await res.json();

        if (!data.success) {
            if (container) container.innerHTML = `<p class="text-rose-500 py-4 text-center">Failed to load history: ${data.error}</p>`;
            return;
        }

        const history = data.history || [];
        const consents = data.consents || [];

        if (history.length === 0 && consents.length === 0) {
            if (container) {
                container.innerHTML = `<div class="py-8 text-center text-slate-400"><i data-lucide="shield-alert" class="w-6 h-6 mx-auto mb-1 text-slate-300"></i>No historical records found for this contact.</div>`;
                if (window.lucide) lucide.createIcons();
            }
            return;
        }

        let html = '';

        // Current status badges summary
        if (consents.length > 0) {
            html += `
                <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                    <span class="font-bold text-[11px] text-slate-700 uppercase tracking-wider block">Current Purpose Consents</span>
                    <div class="flex flex-wrap gap-2">
                        ${consents.map(c => `
                            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold ${c.status === 'OPTED_IN' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}">
                                <span>${c.purpose}:</span>
                                <span>${c.status}</span>
                            </span>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        // Timeline items
        html += `
            <div class="space-y-3 pt-2">
                <span class="font-bold text-[11px] text-slate-700 uppercase tracking-wider block">Immutable Audit Trail</span>
                <div class="relative border-l-2 border-slate-200 ml-3 space-y-4 py-1">
                    ${history.map(item => {
                        const dateStr = item.created_at ? new Date(item.created_at).toLocaleString() : '-';
                        const isOptIn = item.new_status === 'OPTED_IN';
                        const dotColor = isOptIn ? 'bg-emerald-500' : 'bg-rose-500';

                        return `
                            <div class="relative pl-6">
                                <span class="absolute -left-1.5 top-1.5 w-3 h-3 rounded-full ${dotColor} border-2 border-white shadow-xs"></span>
                                <div class="bg-white p-3 rounded-xl border border-slate-200 shadow-xs space-y-1">
                                    <div class="flex items-center justify-between text-[11px]">
                                        <span class="font-bold text-slate-800">${item.event_type} (${item.purpose})</span>
                                        <span class="text-slate-400 font-mono text-[10px]">${dateStr}</span>
                                    </div>
                                    <div class="text-xs text-slate-600">
                                        Transition: <span class="font-mono text-slate-500">${item.previous_status || 'NONE'}</span> &rarr; <span class="font-bold text-slate-800 font-mono">${item.new_status}</span>
                                    </div>
                                    <div class="text-[11px] text-slate-500">
                                        Actor: <span class="font-semibold text-slate-700">${item.actor_id || 'system'}</span> [${item.actor_role || 'SYSTEM'}]
                                    </div>
                                    ${item.evidence ? `<div class="text-[11px] bg-slate-50 p-1.5 rounded border border-slate-100 text-slate-600 mt-1 italic">Evidence: ${item.evidence}</div>` : ''}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;

        if (container) {
            container.innerHTML = html;
            if (window.lucide) lucide.createIcons();
        }
    } catch (err) {
        if (container) container.innerHTML = `<p class="text-rose-500 py-4 text-center">Error: ${err.message}</p>`;
    }
}

function closeConsentHistoryModal() {
    const modal = document.getElementById('modal-consent-history');
    if (modal) modal.classList.add('hidden');
}

function exportAuditLogsCsv() {
    showToast('Exporting compliance audit logs as CSV...', 'info');
    window.location.href = `/api/compliance/audit-logs/export`;
}

// ============================================================================
// CAMPAIGN PREFLIGHT INSPECTION CONTROLLER
// ============================================================================
async function runCampaignPreflightInspection() {
    const targetStage = document.getElementById('camp-stage-select')?.value || 'ALL';
    const templateId = document.getElementById('camp-template-select')?.value || null;
    const customMessage = document.getElementById('camp-custom-msg')?.value.trim() || '';

    if (!customMessage && !templateId) {
        showToast('Please enter message text or select a template before running preflight inspection.', 'error');
        return;
    }

    const modal = document.getElementById('modal-preflight');
    const content = document.getElementById('preflight-modal-content');
    const proceedBtn = document.getElementById('btn-preflight-proceed');

    if (content) {
        content.innerHTML = `
            <div class="py-12 text-center text-slate-500 space-y-3">
                <i data-lucide="loader" class="w-8 h-8 animate-spin mx-auto text-sky-600"></i>
                <p class="font-bold text-slate-700">Evaluating Campaign Compliance Rules...</p>
                <p class="text-xs text-slate-400 max-w-sm mx-auto">Checking recipient consents, suppression records, 24-hour messaging windows, and template placeholder syntax.</p>
            </div>
        `;
    }
    if (modal) modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();

    try {
        const res = await fetch('/api/compliance/preflight', {
            method: 'POST',
            headers: getComplianceHeaders(),
            body: JSON.stringify({
                targetStage,
                templateId,
                customMessage,
                category: 'MARKETING'
            })
        });
        const data = await res.json();

        if (!data.success) {
            if (content) content.innerHTML = `<div class="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-200">Preflight check failed: ${data.error}</div>`;
            return;
        }

        const b = data.breakdown || {};
        const tv = data.templateValidation || { valid: true };
        const contacts = data.contacts || [];

        let reportHtml = `
            <!-- Top Metric Cards -->
            <div class="grid grid-cols-3 gap-3">
                <div class="bg-slate-50 border border-slate-200 p-3 rounded-xl text-center">
                    <span class="text-slate-500 font-semibold text-[10px] uppercase">Audience Size</span>
                    <div class="text-2xl font-black text-slate-900 mt-1">${data.totalAudience}</div>
                    <span class="text-[10px] text-slate-400">Target leads in stage</span>
                </div>
                <div class="bg-emerald-50 border border-emerald-200 p-3 rounded-xl text-center">
                    <span class="text-emerald-700 font-bold text-[10px] uppercase">Eligible to Dispatch</span>
                    <div class="text-2xl font-black text-emerald-600 mt-1">${data.eligibleCount}</div>
                    <span class="text-[10px] text-emerald-600 font-semibold">100% Policy Compliant</span>
                </div>
                <div class="bg-rose-50 border border-rose-200 p-3 rounded-xl text-center">
                    <span class="text-rose-700 font-bold text-[10px] uppercase">Blocked by Guard</span>
                    <div class="text-2xl font-black text-rose-600 mt-1">${data.blockedCount}</div>
                    <span class="text-[10px] text-rose-600 font-semibold">Protected / Skipped</span>
                </div>
            </div>

            <!-- Block Reasons Breakdown -->
            <div class="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div class="font-bold text-slate-700 text-xs flex items-center justify-between">
                    <span>Guard Policy Breakdown</span>
                    <span class="text-[10px] text-slate-500">Evaluates tenant suppression & consent</span>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div class="p-2.5 bg-white rounded-lg border border-slate-200">
                        <span class="text-slate-500 text-[11px] block">Missing Consent</span>
                        <span class="font-bold text-base ${b.missingConsent > 0 ? 'text-amber-600' : 'text-slate-700'}">${b.missingConsent || 0}</span>
                    </div>
                    <div class="p-2.5 bg-white rounded-lg border border-slate-200">
                        <span class="text-slate-500 text-[11px] block">Suppressed / Opt-Out</span>
                        <span class="font-bold text-base ${b.suppressed > 0 ? 'text-rose-600' : 'text-slate-700'}">${b.suppressed || 0}</span>
                    </div>
                    <div class="p-2.5 bg-white rounded-lg border border-slate-200">
                        <span class="text-slate-500 text-[11px] block">24h Window Expired</span>
                        <span class="font-bold text-base ${b.windowExpired > 0 ? 'text-amber-600' : 'text-slate-700'}">${b.windowExpired || 0}</span>
                    </div>
                    <div class="p-2.5 bg-white rounded-lg border border-slate-200">
                        <span class="text-slate-500 text-[11px] block">Invalid Phone</span>
                        <span class="font-bold text-base ${b.invalidPhone > 0 ? 'text-rose-600' : 'text-slate-700'}">${b.invalidPhone || 0}</span>
                    </div>
                </div>
            </div>

            <!-- Template Content Guard Card -->
            <div class="p-3.5 ${tv.valid ? 'bg-sky-50 border-sky-200' : 'bg-amber-50 border-amber-200'} rounded-xl border space-y-1.5">
                <div class="flex items-center justify-between font-bold text-xs ${tv.valid ? 'text-sky-900' : 'text-amber-900'}">
                    <span class="flex items-center gap-1.5">
                        <i data-lucide="${tv.valid ? 'check-circle' : 'alert-triangle'}" class="w-4 h-4"></i>
                        <span>Template Content Guard: ${tv.valid ? 'PASSED' : 'ACTION REQUIRED'}</span>
                    </span>
                    <span class="text-[10px] px-2 py-0.5 rounded font-bold uppercase ${tv.valid ? 'bg-sky-200/60 text-sky-900' : 'bg-amber-200 text-amber-900'}">${tv.valid ? 'Approved' : 'Attention'}</span>
                </div>
                ${tv.errors && tv.errors.length > 0 ? `
                    <ul class="list-disc list-inside text-[11px] text-amber-800 space-y-0.5">
                        ${tv.errors.map(err => `<li>${err}</li>`).join('')}
                    </ul>
                ` : ''}
                ${tv.warnings && tv.warnings.length > 0 ? `
                    <ul class="list-disc list-inside text-[11px] text-sky-800 space-y-0.5">
                        ${tv.warnings.map(w => `<li>${w}</li>`).join('')}
                    </ul>
                ` : ''}
                <p class="text-[10px] text-slate-500 italic mt-1 border-t border-slate-200/60 pt-1">
                    ${tv.heuristicNotice || 'Policy Notice: Heuristic checks evaluate policy hygiene but do not guarantee Meta template approval.'}
                </p>
            </div>

            ${data.formattedPreview ? `
                <div class="p-3 bg-emerald-50/70 border border-emerald-200 rounded-xl space-y-1">
                    <div class="text-[11px] font-bold text-emerald-900 flex items-center justify-between">
                        <span>Final Outbound Message Preview (With Auto-Appended Opt-Out Footer)</span>
                        <span class="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-mono">Compliance Guard</span>
                    </div>
                    <pre class="text-xs text-slate-800 whitespace-pre-wrap font-sans bg-white p-2.5 rounded-lg border border-emerald-100 max-h-32 overflow-y-auto">${data.formattedPreview}</pre>
                </div>
            ` : ''}

            <!-- Contact Eligibility Sample Table -->
            <div class="space-y-1.5">
                <span class="font-bold text-slate-700 text-xs">Recipient Inspection (Sample ${contacts.length} leads)</span>
                <div class="border border-slate-200 rounded-lg max-h-48 overflow-y-auto">
                    <table class="w-full text-left text-xs">
                        <thead class="bg-slate-50 text-slate-500 uppercase text-[10px] border-b border-slate-200 sticky top-0">
                            <tr>
                                <th class="p-2">Lead</th>
                                <th class="p-2">Phone</th>
                                <th class="p-2">Status</th>
                                <th class="p-2">Guard Reason</th>
                                <th class="p-2 text-right">Quick Action</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-100">
                            ${contacts.map(c => `
                                <tr class="${c.eligible ? 'hover:bg-emerald-50/40' : 'bg-rose-50/20 hover:bg-rose-50/40'}">
                                    <td class="p-2 font-semibold text-slate-800">${c.name}</td>
                                    <td class="p-2 font-mono text-slate-600">${c.phone}</td>
                                    <td class="p-2">
                                        <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${c.eligible ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
                                            ${c.eligible ? 'ELIGIBLE' : 'BLOCKED'}
                                        </span>
                                    </td>
                                    <td class="p-2 text-slate-500 text-[11px]">${c.blockReason || 'Cleared (Compliant)'}</td>
                                    <td class="p-2 text-right">
                                        ${!c.eligible && c.blockReason.includes('MISSING_CONSENT') ? `
                                            <button onclick="closePreflightModal(); openCaptureConsentModal('${c.phone}');" class="text-blue-600 hover:underline font-bold text-[10px]">Capture Consent</button>
                                        ` : (c.eligible ? `<span class="text-emerald-600 font-bold text-[10px]">Ready</span>` : `<span class="text-slate-400 text-[10px]">Skipped</span>`)}
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        if (content) content.innerHTML = reportHtml;

        // Proceed button update
        if (proceedBtn) {
            if (data.eligibleCount === 0) {
                proceedBtn.disabled = true;
                proceedBtn.textContent = 'No Eligible Contacts (Blocked)';
                proceedBtn.className = 'px-5 py-2 bg-slate-300 text-slate-500 cursor-not-allowed rounded-lg text-xs font-bold';
            } else {
                proceedBtn.disabled = false;
                proceedBtn.textContent = `Proceed & Dispatch to ${data.eligibleCount} Contact(s)`;
                proceedBtn.className = 'px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold shadow-sm';
            }
        }

        if (window.lucide) lucide.createIcons();
    } catch (err) {
        if (content) content.innerHTML = `<div class="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-200">Error running preflight inspection: ${err.message}</div>`;
    }
}

function closePreflightModal() {
    const modal = document.getElementById('modal-preflight');
    if (modal) modal.classList.add('hidden');
}

function proceedFromPreflightToLaunch() {
    closePreflightModal();
    launchBroadcastCampaign();
}
