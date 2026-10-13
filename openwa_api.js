const db = require('./database');
const path = require('path');
const fs = require('fs');

/**
 * OpenWA API Gateway Connector
 * Integrates with https://github.com/rmyndharis/OpenWA
 * Free, Open Source, Self-Hosted WhatsApp API Gateway
 */
class OpenWAService {
    constructor() {
        this.config = {
            serverUrl: process.env.OPENWA_SERVER_URL || 'http://localhost:2785/api',
            apiKey: process.env.OPENWA_API_KEY || '',
            sessionId: process.env.OPENWA_SESSION_ID || 'default',
            enabled: process.env.OPENWA_ENABLED === 'true' || process.env.OPENWA_ENABLED === '1'
        };
        this.isLoaded = false;
        this.sessionUuidCache = new Map();
        this.webhookRegistered = false;
    }

    async loadConfig() {
        try {
            await db.run(`
                CREATE TABLE IF NOT EXISTS openwa_config (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `);

            const rows = await db.all(`SELECT key, value FROM openwa_config`);
            for (const r of rows) {
                if (r.key === 'server_url' && r.value) this.config.serverUrl = r.value;
                if (r.key === 'api_key' && r.value) this.config.apiKey = r.value;
                if (r.key === 'session_id' && r.value) this.config.sessionId = r.value;
                if (r.key === 'enabled') this.config.enabled = r.value === '1' || r.value === 'true';
            }

            if (process.env.OPENWA_SERVER_URL) this.config.serverUrl = process.env.OPENWA_SERVER_URL;
            if (process.env.OPENWA_API_KEY) this.config.apiKey = process.env.OPENWA_API_KEY;

            // Auto-detect local OpenWA API key if none set yet
            if (!this.config.apiKey) {
                const localKeyPath = path.join(__dirname, 'OpenWA', 'data', '.api-key');
                if (fs.existsSync(localKeyPath)) {
                    const discoveredKey = fs.readFileSync(localKeyPath, 'utf8').trim();
                    if (discoveredKey) {
                        this.config.apiKey = discoveredKey;
                        await db.run(`INSERT INTO openwa_config (key, value) VALUES ('api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [discoveredKey]);
                    }
                }
            }
            this.isLoaded = true;
            if (this.config.enabled && !this.webhookRegistered) {
                this.ensureWebhookRegistered().catch(() => {});
            }
        } catch (e) {
            console.error('[OpenWA Config Error]', e.message);
        }
    }

    async ensureWebhookRegistered() {
        if (this.webhookRegistered) return;
        const sqlitePath = path.join(__dirname, 'OpenWA', 'data', 'openwa.sqlite');
        if (!fs.existsSync(sqlitePath)) return;

        try {
            const crypto = require('crypto');
            const sqlite3 = require('sqlite3');
            const webhookUrl = process.env.CRM_WEBHOOK_URL || `http://127.0.0.1:${process.env.PORT || 3000}/api/webhooks/whatsapp`;
            const owaDb = new sqlite3.Database(sqlitePath);

            await new Promise((resolve) => {
                owaDb.get(`SELECT id FROM sessions WHERE name = ? LIMIT 1`, [this.config.sessionId || 'default'], (err, sess) => {
                    if (err || !sess || !sess.id) {
                        owaDb.close();
                        return resolve();
                    }
                    owaDb.get(`SELECT id FROM webhooks WHERE session_id = ? AND url = ? LIMIT 1`, [sess.id, webhookUrl], (err2, existing) => {
                        if (existing && existing.id) {
                            this.webhookRegistered = true;
                            owaDb.close();
                            return resolve();
                        }
                        const id = crypto.randomUUID();
                        const events = JSON.stringify(['message.received', 'message.sent', 'message.ack', 'message.failed']);
                        owaDb.run(
                            `INSERT INTO webhooks (id, session_id, url, events, enabled, retry_count) VALUES (?, ?, ?, ?, 1, 3)`,
                            [id, sess.id, webhookUrl, events],
                            () => {
                                this.webhookRegistered = true;
                                owaDb.close();
                                resolve();
                            }
                        );
                    });
                });
            });
        } catch (e) {
            // Non-blocking if OpenWA DB is locked or not initialized
        }
    }

    async updateConfig({ serverUrl, apiKey, sessionId, enabled }) {
        await this.loadConfig();
        if (serverUrl !== undefined) this.config.serverUrl = serverUrl.trim().replace(/\/+$/, '');
        if (apiKey !== undefined) this.config.apiKey = apiKey.trim();
        if (sessionId !== undefined) this.config.sessionId = sessionId.trim() || 'default';
        if (enabled !== undefined) this.config.enabled = !!enabled;

        const entries = [
            ['server_url', this.config.serverUrl],
            ['api_key', this.config.apiKey],
            ['session_id', this.config.sessionId],
            ['enabled', this.config.enabled ? '1' : '0']
        ];

        for (const [k, v] of entries) {
            await db.run(`
                INSERT INTO openwa_config (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `, [k, v]);
        }

        return this.getPublicConfig();
    }

    getPublicConfig() {
        return {
            serverUrl: this.config.serverUrl,
            sessionId: this.config.sessionId,
            enabled: this.config.enabled,
            hasApiKey: !!this.config.apiKey,
            maskedApiKey: this.config.apiKey ? `••••••••${this.config.apiKey.slice(-4)}` : ''
        };
    }

    formatChatId(phone) {
        const clean = phone.toString().replace(/\D/g, '');
        return clean.includes('@') ? clean : `${clean}@c.us`;
    }

    getHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (this.config.apiKey) {
            headers['X-API-Key'] = this.config.apiKey;
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }
        return headers;
    }

    async resolveSessionId(sessionNameOrUuid) {
        const id = (sessionNameOrUuid || this.config.sessionId || 'default').trim();
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        if (isUuid) return id;

        // Return from memory cache if already resolved
        if (this.sessionUuidCache && this.sessionUuidCache.has(id)) {
            return this.sessionUuidCache.get(id);
        }

        try {
            // Direct SQLite fast lookup if OpenWA database file exists
            const sqlitePath = path.join(__dirname, 'OpenWA', 'data', 'openwa.sqlite');
            if (fs.existsSync(sqlitePath)) {
                try {
                    const sqlite3 = require('sqlite3');
                    const owaDb = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY);
                    const row = await new Promise((res) => {
                        owaDb.get('SELECT id FROM sessions WHERE name = ? LIMIT 1', [id], (err, r) => {
                            owaDb.close();
                            res(r);
                        });
                    });
                    if (row && row.id) {
                        this.sessionUuidCache.set(id, row.id);
                        return row.id;
                    }
                } catch (e) {}
            }

            // Find existing session by name via HTTP
            const res = await fetch(`${this.config.serverUrl}/sessions?name=${encodeURIComponent(id)}`, {
                headers: this.getHeaders(),
                signal: AbortSignal.timeout(4000)
            });
            if (res.ok) {
                const sessions = await res.json();
                if (Array.isArray(sessions) && sessions.length > 0 && sessions[0].id) {
                    this.sessionUuidCache.set(id, sessions[0].id);
                    return sessions[0].id;
                }
            }

            // Create session if it doesn't exist yet
            const createRes = await fetch(`${this.config.serverUrl}/sessions`, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({ name: id }),
                signal: AbortSignal.timeout(4000)
            });
            if (createRes.ok) {
                const newSession = await createRes.json();
                if (newSession && newSession.id) {
                    this.sessionUuidCache.set(id, newSession.id);
                    return newSession.id;
                }
            }
        } catch (e) {
            console.warn('[OpenWA] Session resolution note:', e.message);
        }

        return id;
    }

    async testConnection() {
        await this.loadConfig();
        const base = this.config.serverUrl.replace(/\/api\/?$/, '');

        // 1. Check /api/health
        let healthOk = false;
        try {
            const healthRes = await fetch(`${this.config.serverUrl}/health`, { signal: AbortSignal.timeout(4000) });
            if (healthRes.ok) healthOk = true;
        } catch (e) {}

        if (!healthOk) {
            try {
                const baseHealth = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
                if (baseHealth.ok) healthOk = true;
            } catch (e) {}
        }

        // 2. Check /api/sessions with API key
        let sessionStatus = 'READY';
        let resolvedUuid = null;
        try {
            resolvedUuid = await this.resolveSessionId(this.config.sessionId);
            const sessRes = await fetch(`${this.config.serverUrl}/sessions/${resolvedUuid}`, {
                headers: this.getHeaders(),
                signal: AbortSignal.timeout(4000)
            });
            if (sessRes.ok) {
                const sessData = await sessRes.json();
                sessionStatus = sessData.status || 'READY';
            }
        } catch (e) {
            console.warn('[OpenWA] Session check info:', e.message);
        }

        if (healthOk) {
            return {
                success: true,
                serverUrl: this.config.serverUrl,
                sessionId: this.config.sessionId,
                resolvedUuid,
                sessionStatus,
                health: 'OK'
            };
        }

        throw new Error(`OpenWA server at ${this.config.serverUrl} is unreachable. Ensure OpenWA is running on port 2785.`);
    }

    async sendTextMessage(to, text) {
        await this.loadConfig();
        const chatId = this.formatChatId(to);
        const resolvedSession = await this.resolveSessionId(this.config.sessionId);
        const url = `${this.config.serverUrl}/sessions/${resolvedSession}/messages/send-text`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                chatId,
                text
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.message || data.error || `OpenWA HTTP ${response.status}`);
        }

        return {
            success: true,
            providerMessageId: data.id || data.messageId || data.key?.id || `openwa_${Date.now()}`,
            data
        };
    }

    getMimeType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeMap = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.mp4': 'video/mp4',
            '.3gp': 'video/3gpp',
            '.mov': 'video/quicktime',
            '.avi': 'video/x-msvideo',
            '.mkv': 'video/x-matroska',
            '.webm': 'video/webm',
            '.mp3': 'audio/mpeg',
            '.ogg': 'audio/ogg',
            '.wav': 'audio/wav',
            '.m4a': 'audio/mp4',
            '.aac': 'audio/aac',
            '.pdf': 'application/pdf',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.txt': 'text/plain',
            '.csv': 'text/csv'
        };
        return mimeMap[ext] || 'application/octet-stream';
    }

    async sendMediaMessage(to, mediaPath, caption = '') {
        await this.loadConfig();
        const chatId = this.formatChatId(to);
        const resolvedSession = await this.resolveSessionId(this.config.sessionId);

        // Determine correct endpoint by file extension
        let endpoint = 'send-document';
        if (/\.(jpg|jpeg|png|webp|gif)$/i.test(mediaPath)) {
            endpoint = 'send-image';
        } else if (/\.(mp4|3gp|mov|avi|mkv|webm)$/i.test(mediaPath)) {
            endpoint = 'send-video';
        } else if (/\.(mp3|ogg|wav|m4a|aac)$/i.test(mediaPath)) {
            endpoint = 'send-audio';
        }

        const url = `${this.config.serverUrl}/sessions/${resolvedSession}/messages/${endpoint}`;
        const payload = { chatId };

        if (caption) {
            payload.caption = caption;
        }

        if (mediaPath.startsWith('http://') || mediaPath.startsWith('https://')) {
            payload.url = mediaPath;
        } else if (fs.existsSync(mediaPath)) {
            // Local file on disk: read directly to base64 to bypass SSRF or network loopback restrictions
            const fileBuffer = fs.readFileSync(mediaPath);
            payload.base64 = fileBuffer.toString('base64');
            payload.mimetype = this.getMimeType(mediaPath);
            if (endpoint === 'send-document') {
                payload.filename = path.basename(mediaPath);
            }
        } else {
            const filename = path.basename(mediaPath);
            payload.url = `http://127.0.0.1:3000/uploads/media/${filename}`;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(payload)
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.message || data.error || `OpenWA media HTTP ${response.status}`);
        }

        return {
            success: true,
            providerMessageId: data.id || data.messageId || data.key?.id || `openwa_${Date.now()}`,
            data
        };
    }

    async startSession() {
        await this.loadConfig();
        const resolvedSession = await this.resolveSessionId(this.config.sessionId);
        const url = `${this.config.serverUrl}/sessions/${resolvedSession}/start`;
        const res = await fetch(url, { method: 'POST', headers: this.getHeaders() });
        const data = await res.json().catch(() => ({}));
        return data;
    }

    async getSessionDetails() {
        await this.loadConfig();
        try {
            const resolvedSession = await this.resolveSessionId(this.config.sessionId);
            const res = await fetch(`${this.config.serverUrl}/sessions/${resolvedSession}`, {
                headers: this.getHeaders(),
                signal: AbortSignal.timeout(3500)
            });
            if (res.ok) return await res.json();
        } catch (e) {}
        return null;
    }

    async getQrCode() {
        await this.loadConfig();
        const resolvedSession = await this.resolveSessionId(this.config.sessionId);
        const url = `${this.config.serverUrl}/sessions/${resolvedSession}/qr`;
        const res = await fetch(url, { headers: this.getHeaders() });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            if (res.status === 400 && data.message && (data.message.includes('not ready') || data.message.includes('already authenticated'))) {
                return { qrCode: null, status: 'initializing', message: data.message };
            }
            throw new Error(data.message || `OpenWA QR request failed: HTTP ${res.status}`);
        }
        return await res.json();
    }

    async requestPairingCode(phoneNumber) {
        await this.loadConfig();
        const resolvedSession = await this.resolveSessionId(this.config.sessionId);
        const cleanNumber = String(phoneNumber || '').replace(/\D/g, '');
        if (!cleanNumber || cleanNumber.length < 6 || cleanNumber.length > 15) {
            throw new Error('Phone number must be 6 to 15 digits including country code (e.g. 919876543210)');
        }
        const url = `${this.config.serverUrl}/sessions/${resolvedSession}/pairing-code`;
        const res = await fetch(url, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({ phoneNumber: cleanNumber })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.message || data.error || `Failed to request pairing code: HTTP ${res.status}`);
        }
        return data;
    }

    async restartSession() {
        await this.loadConfig();
        const resolvedSession = await this.resolveSessionId(this.config.sessionId);
        try {
            await fetch(`${this.config.serverUrl}/sessions/${resolvedSession}/stop`, {
                method: 'POST',
                headers: this.getHeaders()
            });
        } catch (e) {}
        await new Promise(r => setTimeout(r, 1500));
        return await this.startSession();
    }

    async forceResetSession() {
        await this.loadConfig();
        const resolvedSession = await this.resolveSessionId(this.config.sessionId);
        try {
            await fetch(`${this.config.serverUrl}/sessions/${resolvedSession}/force-kill`, {
                method: 'POST',
                headers: this.getHeaders()
            });
        } catch (e) {}

        const cleanPuppeteer = require('./clean_puppeteer');
        if (typeof cleanPuppeteer === 'function') {
            try { cleanPuppeteer(); } catch (e) {}
        }

        await new Promise(r => setTimeout(r, 1200));
        return await this.startSession();
    }
}

const openwa = new OpenWAService();
openwa.loadConfig().catch(() => {});

module.exports = openwa;
