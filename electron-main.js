const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow = null;
let serverInstance = null;
const PORT = process.env.PORT || 3000;
const SERVER_URL = `http://localhost:${PORT}`;

// Helper: Check if local CRM server is responding
function checkServerHealthy() {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1200, () => {
            req.abort();
            resolve(false);
        });
    });
}

// Start backend Express server if not already running on port 3000
async function ensureServerRunning() {
    const isAlreadyRunning = await checkServerHealthy();
    if (isAlreadyRunning) {
        console.log(`[Electron] CRM server already running at ${SERVER_URL}`);
        return;
    }

    try {
        const cleanPuppeteer = require('./clean_puppeteer');
        if (typeof cleanPuppeteer === 'function') cleanPuppeteer();
    } catch (e) {}

    console.log('[Electron] Starting embedded CRM Express server...');
    process.env.ELECTRON_RUN = 'true';
    serverInstance = require('./server');

    // Wait up to 15 seconds for server to be healthy
    let attempts = 0;
    while (attempts < 30) {
        const ready = await checkServerHealthy();
        if (ready) return;
        await new Promise((r) => setTimeout(r, 500));
        attempts++;
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1420,
        height: 920,
        minWidth: 1080,
        minHeight: 720,
        title: 'LeadSquared CRM + WhatsApp Automation',
        icon: path.join(__dirname, 'public', 'favicon.ico'),
        autoHideMenuBar: true,
        backgroundColor: '#f8fafc',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
        }
    });

    mainWindow.loadURL(SERVER_URL);

    // Open external links (e.g. privacy policies, WhatsApp web links) in user's default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.startsWith(`http://localhost:${PORT}`) && !url.startsWith(`http://127.0.0.1:${PORT}`)) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Ensure single instance lock so double-clicking doesn't launch 2 instances
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        await ensureServerRunning();
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

app.on('window-all-closed', async () => {
    try {
        const whatsapp = require('./whatsapp');
        if (whatsapp && typeof whatsapp.disconnect === 'function') {
            await whatsapp.disconnect();
        }
    } catch (e) {}

    if (process.platform !== 'darwin') {
        app.quit();
    }
});
