const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const db = require('./database');
const openwa = require('./openwa_api');
const cloudApi = require('./whatsapp_cloud_api');
const complianceService = require('./compliance_service');

const cleanPuppeteer = require('./clean_puppeteer');

function cleanStalePuppeteerLocks() {
    try {
        if (typeof cleanPuppeteer === 'function') {
            cleanPuppeteer();
        }
    } catch (e) {}

    try {
        const sessionDir = path.join(__dirname, '.wwebjs_auth', 'session');
        if (fs.existsSync(sessionDir)) {
            const lockFile = path.join(sessionDir, 'lockfile');
            const portFile = path.join(sessionDir, 'DevToolsActivePort');
            if (fs.existsSync(lockFile)) {
                try { fs.unlinkSync(lockFile); } catch (e) {}
            }
            if (fs.existsSync(portFile)) {
                try { fs.unlinkSync(portFile); } catch (e) {}
            }
        }
    } catch (e) {}
}

class WhatsAppService {
    constructor() {
        this.client = null;
        this.status = 'DISCONNECTED'; // DISCONNECTED, INITIALIZING, SCAN_QR, CONNECTED, FAILED
        this.qrDataUrl = null;
        this.rawQr = null;
        this.userInfo = null;
        this.lastError = null;
        this.queue = [];
        this.isProcessingQueue = false;
        this.minDelayMs = 4000;
        this.maxDelayMs = 8000;
        this.listeners = [];

        // OpenWA state cache
        this.openwaSessionStatus = null;
        this.openwaQr = null;
        this.openwaUserInfo = null;

        this.openwaInterval = setInterval(() => this.refreshOpenWAState(), 3500);
        if (this.openwaInterval && this.openwaInterval.unref) {
            this.openwaInterval.unref();
        }
    }

    async refreshOpenWAState() {
        if (!openwa.config || !openwa.config.enabled) return;
        try {
            const sess = await openwa.getSessionDetails();
            if (sess) {
                this.openwaSessionStatus = sess.status;
                if (sess.phone) {
                    this.openwaUserInfo = { number: sess.phone, pushname: sess.pushName || 'OpenWA' };
                } else {
                    this.openwaUserInfo = null;
                }
                if (sess.status === 'qr_ready') {
                    const qr = await openwa.getQrCode().catch(() => null);
                    if (qr && qr.qrCode) {
                        this.openwaQr = qr.qrCode;
                    }
                } else if (sess.status === 'ready' || sess.status === 'connected') {
                    this.openwaQr = null;
                } else if (sess.status === 'created' || sess.status === 'failed' || sess.status === 'stopped' || sess.status === 'closed') {
                    // Auto-start session so QR or existing auth is restored
                    if (!this._openwaRestartAttempt || Date.now() - this._openwaRestartAttempt > 10000) {
                        this._openwaRestartAttempt = Date.now();
                        await openwa.startSession().catch(() => {});
                    }
                }
            }
        } catch (e) {}
    }

    getStatus() {
        let activeEngine = 'BUILTIN_WEB';
        let currentStatus = this.status;
        let qrDataUrl = this.qrDataUrl;
        let userInfo = this.userInfo;

        if (openwa.config && openwa.config.enabled) {
            activeEngine = 'OPENWA_GATEWAY';
            const owaStatus = this.openwaSessionStatus || 'INITIALIZING';
            if (owaStatus === 'ready' || owaStatus === 'connected') {
                currentStatus = 'CONNECTED';
                userInfo = this.openwaUserInfo || { number: 'OpenWA', pushname: 'Connected' };
                qrDataUrl = null;
            } else if (owaStatus === 'qr_ready') {
                currentStatus = 'SCAN_QR';
                qrDataUrl = this.openwaQr;
                userInfo = null;
            } else if (owaStatus === 'starting' || owaStatus === 'initializing') {
                currentStatus = 'INITIALIZING';
                qrDataUrl = null;
                userInfo = null;
            } else if (owaStatus === 'failed') {
                currentStatus = 'FAILED';
                qrDataUrl = null;
                userInfo = null;
            } else {
                currentStatus = this.openwaQr ? 'SCAN_QR' : 'INITIALIZING';
                qrDataUrl = this.openwaQr;
                userInfo = null;
            }
        } else if (cloudApi.isCloudApiActive && cloudApi.isCloudApiActive()) {
            activeEngine = 'META_CLOUD_API';
            currentStatus = 'CONNECTED';
        }

        return {
            activeEngine,
            status: currentStatus,
            qrDataUrl,
            userInfo,
            queueLength: this.queue.length,
            lastError: this.lastError,
            openwa: openwa.getPublicConfig ? openwa.getPublicConfig() : null,
            cloudApi: cloudApi.getPublicConfig ? cloudApi.getPublicConfig() : null
        };
    }

    async init() {
        if (this.client && (this.status === 'CONNECTED' || this.status === 'INITIALIZING')) {
            console.log('WhatsApp client already active or initializing.');
            return;
        }

        if (this.client) {
            try {
                await this.client.destroy().catch(() => {});
            } catch (e) {}
            this.client = null;
        }

        cleanStalePuppeteerLocks();

        this.status = 'INITIALIZING';
        this.qrDataUrl = null;
        this.rawQr = null;
        this.userInfo = null;
        this.lastError = null;
        this.notifyStatusChange();

        try {
            console.log('Initializing WhatsApp Web client with LocalAuth...');
            this.client = new Client({
                authStrategy: new LocalAuth({
                    dataPath: path.join(__dirname, '.wwebjs_auth')
                }),
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
                },
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu',
                        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
                    ]
                }
            });

            this.client.on('qr', async (qr) => {
                console.log('New WhatsApp QR code generated.');
                this.rawQr = qr;
                this.status = 'SCAN_QR';
                try {
                    this.qrDataUrl = await qrcode.toDataURL(qr, { width: 300, margin: 2 });
                } catch (err) {
                    console.error('Error generating QR data URL:', err);
                }
                this.notifyStatusChange();
            });

            this.client.on('ready', async () => {
                console.log('WhatsApp Web client is CONNECTED and READY!');
                this.status = 'CONNECTED';
                this.qrDataUrl = null;
                const info = this.client.info || {};
                this.userInfo = {
                    number: info.wid ? info.wid.user : 'Unknown',
                    pushname: info.pushname || 'User',
                    platform: info.platform || 'WhatsApp Web'
                };

                // Runtime browser patch: protect against WhatsApp Web media memoization bug
                try {
                    if (this.client.pupPage) {
                        await this.client.pupPage.evaluate(() => {
                            if (window.WWebJS && window.WWebJS.sendMessage) {
                                const originalSend = window.WWebJS.sendMessage;
                                window.WWebJS.sendMessage = async function(chat, content, options = {}) {
                                    if (options && options.media) {
                                        delete options.media.__x_id;
                                    }
                                    return originalSend.apply(this, arguments);
                                };
                            }
                        });
                    }
                } catch (patchErr) {
                    console.warn('[WhatsApp] Media runtime patch notice:', patchErr.message);
                }

                this.notifyStatusChange();
            });

            this.client.on('authenticated', () => {
                console.log('WhatsApp client authenticated successfully.');
            });

            this.client.on('auth_failure', (msg) => {
                console.error('WhatsApp authentication failure:', msg);
                this.status = 'FAILED';
                this.lastError = typeof msg === 'string' ? msg : 'Authentication failed. Please scan QR code again.';
                this.notifyStatusChange();
            });

            this.client.on('disconnected', (reason) => {
                console.log('WhatsApp client was disconnected:', reason);
                this.status = 'DISCONNECTED';
                this.qrDataUrl = null;
                this.rawQr = null;
                this.userInfo = null;
                this.notifyStatusChange();
            });

            // Handle incoming messages
            this.client.on('message', async (msg) => {
                await this.handleIncomingMessage(msg);
            });

            await this.client.initialize();
        } catch (err) {
            console.error('Failed to initialize WhatsApp client:', err);
            this.status = 'FAILED';
            this.lastError = err.message || 'Failed to initialize WhatsApp client.';
            if (this.client) {
                try {
                    await this.client.destroy().catch(() => {});
                } catch (e) {}
                this.client = null;
            }
            this.notifyStatusChange();
        }
    }

    async disconnect() {
        if (this.client) {
            try {
                await this.client.destroy();
            } catch (err) {
                console.error('Error destroying WhatsApp client:', err);
            }
            this.client = null;
        }
        this.status = 'DISCONNECTED';
        this.qrDataUrl = null;
        this.rawQr = null;
        this.userInfo = null;
        this.notifyStatusChange();
    }

    async resetSession() {
        console.log('[WhatsApp] Resetting session and clearing credentials...');
        await this.disconnect();
        cleanStalePuppeteerLocks();
        const authPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
                console.log('[WhatsApp] Successfully removed .wwebjs_auth directory.');
            } catch (e) {
                console.warn('[WhatsApp] Could not delete .wwebjs_auth:', e.message);
            }
        }
        this.status = 'DISCONNECTED';
        this.qrDataUrl = null;
        this.rawQr = null;
        this.userInfo = null;
        this.lastError = null;
        this.notifyStatusChange();
    }

    notifyStatusChange() {
        // Can be used for SSE or websocket subscribers
        for (const cb of this.listeners) {
            try { cb(this.getStatus()); } catch (e) {}
        }
    }

    onStatusChange(cb) {
        this.listeners.push(cb);
    }

    cleanPhoneNumber(phone, defaultCountryCode = '91') {
        if (!phone) return null;
        let cleaned = phone.toString().replace(/\D/g, ''); // strip all non-digits
        
        // If 10 digits (common for India / US etc.), prepend default country code if provided
        if (cleaned.length === 10) {
            cleaned = defaultCountryCode + cleaned;
        }
        return cleaned;
    }

    formatJid(cleanPhone) {
        return `${cleanPhone}@c.us`;
    }

    // Queue a message (text or media with caption) for safe throttled sending
    queueMessage({ leadId, phone, message, mediaPath = null, campaignId = null, tenantId = 'default', category = 'MARKETING', complianceChecked = false }) {
        const cleanPhone = this.cleanPhoneNumber(phone);
        if (!cleanPhone) {
            return Promise.reject(new Error('Invalid phone number provided'));
        }

        return new Promise((resolve, reject) => {
            const task = {
                leadId,
                cleanPhone,
                rawPhone: phone,
                message,
                mediaPath,
                campaignId,
                tenantId: tenantId || 'default',
                category: category || 'MARKETING',
                complianceChecked: !!complianceChecked,
                resolve,
                reject
            };
            this.queue.push(task);
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessingQueue || this.queue.length === 0) return;
        this.isProcessingQueue = true;

        while (this.queue.length > 0) {
            const task = this.queue.shift();

            const tenantId = task.tenantId || 'default';
            const category = task.category || 'MARKETING';
            const settings = await complianceService.getTenantSettings(tenantId);

            // Ensure mandatory compliance opt-out footer is appended if missing
            if (task.message) {
                task.message = complianceService.applyComplianceFormatting(task.message, category, settings);
            }

            // Pre-dispatch Suppression Check
            if (task.cleanPhone) {
                const supp = await complianceService.checkSuppression(tenantId, task.cleanPhone, category);
                if (supp.suppressed) {
                    const blockErr = new Error(`Message blocked: Contact ${task.cleanPhone} is on suppression list (${supp.record.reason}).`);
                    await complianceService.logAudit({
                        tenantId,
                        action: 'DISPATCH_BLOCKED',
                        entityType: 'MESSAGE',
                        status: 'BLOCKED',
                        details: { to: task.cleanPhone, category, reason: 'SUPPRESSED', suppressionReason: supp.record.reason }
                    });
                    try {
                        await db.run(`
                            INSERT INTO whatsapp_logs (tenant_id, lead_id, phone, message, media_path, category, direction, status, error_message)
                            VALUES (?, ?, ?, ?, ?, ?, 'OUTGOING', 'BLOCKED_SUPPRESSED', ?)
                        `, [tenantId, task.leadId || null, task.cleanPhone, task.message, task.mediaPath || '', category, blockErr.message]);
                    } catch (e) {}
                    task.reject(blockErr);
                    continue;
                }
            }

            // If not already audited by CampaignManager, log compliance audit decision
            if (!task.complianceChecked && task.cleanPhone) {
                const activeProvider = (openwa.config && openwa.config.enabled) ? 'OPENWA' : ((cloudApi.isCloudApiActive && cloudApi.isCloudApiActive()) ? 'CLOUD_API' : 'WEB');
                const contentValidation = complianceService.validateTemplateContent(task.message || '[Media Attachment]', category, settings);
                await complianceService.logAudit({
                    tenantId,
                    action: 'DISPATCH_APPROVED',
                    entityType: 'MESSAGE',
                    status: 'APPROVED',
                    details: {
                        to: task.cleanPhone,
                        category,
                        providerType: activeProvider,
                        warnings: contentValidation.warnings || []
                    }
                });
            }

            let providerMessageId = '';
            let mediaObj = null;

            const isTestEnv = process.env.NODE_ENV === 'test' || 
                              process.argv.some(a => a.includes('test')) || 
                              process.execArgv.some(a => a.includes('test')) ||
                              this.mockMode;

            // Engine Branch 0: Test Sandbox / Mock Mode
            if (isTestEnv) {
                providerMessageId = `mock_wamid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            }
            // Engine Branch 1: OpenWA Self-Hosted Gateway (rmyndharis/OpenWA)
            else if (openwa.config && openwa.config.enabled) {
                try {
                    console.log(`[OpenWA Dispatch] Sending to ${task.cleanPhone}...`);
                    let apiRes;
                    if (task.mediaPath && fs.existsSync(task.mediaPath)) {
                        apiRes = await openwa.sendMediaMessage(task.cleanPhone, task.mediaPath, task.message);
                    } else {
                        apiRes = await openwa.sendTextMessage(task.cleanPhone, task.message);
                    }
                    providerMessageId = apiRes.providerMessageId || '';
                } catch (err) {
                    console.error('[OpenWA Dispatch Error]', err.message);
                    try {
                        await db.run(`
                            INSERT INTO whatsapp_logs (lead_id, phone, message, media_path, direction, status, error_message)
                            VALUES (NULL, ?, ?, ?, 'OUTGOING', 'FAILED', ?)
                        `, [task.rawPhone, task.message, task.mediaPath || '', err.message]);
                    } catch (e) {}
                    task.reject(err);
                    continue;
                }
            }
            // Engine Branch 2: Official Meta Cloud API
            else if (cloudApi.isCloudApiActive && cloudApi.isCloudApiActive()) {
                try {
                    console.log(`[Meta Cloud API Dispatch] Sending to ${task.cleanPhone}...`);
                    const apiRes = await cloudApi.sendMessage({
                        to: task.cleanPhone,
                        message: task.message,
                        mediaPath: task.mediaPath
                    });
                    providerMessageId = apiRes.providerMessageId || '';
                } catch (err) {
                    console.error('[Meta Cloud API Dispatch Error]', err.message);
                    try {
                        await db.run(`
                            INSERT INTO whatsapp_logs (lead_id, phone, message, media_path, direction, status, error_message)
                            VALUES (NULL, ?, ?, ?, 'OUTGOING', 'FAILED', ?)
                        `, [task.rawPhone, task.message, task.mediaPath || '', err.message]);
                    } catch (e) {}
                    task.reject(err);
                    continue;
                }
            }
            // Engine Branch 3: Built-in Headless WhatsApp Web
            else {
                if (this.status !== 'CONNECTED' || !this.client) {
                    const err = new Error('WhatsApp client is not connected. Please scan QR code first or enable OpenWA Gateway.');
                    task.reject(err);
                    try {
                        await db.run(`
                            INSERT INTO whatsapp_logs (lead_id, phone, message, media_path, direction, status, error_message)
                            VALUES (NULL, ?, ?, ?, 'OUTGOING', 'FAILED', ?)
                        `, [task.rawPhone, task.message, task.mediaPath || '', err.message]);
                    } catch (e) {
                        console.error('Failed to log message error:', e.message);
                    }
                    continue;
                }

                try {
                    const jid = this.formatJid(task.cleanPhone);
                    console.log(`[WhatsApp Web Queue] Sending to ${jid}...`);

                    if (task.mediaPath && fs.existsSync(task.mediaPath)) {
                        console.log(`[WhatsApp Web Queue] Loading media attachment: ${task.mediaPath}`);
                        mediaObj = MessageMedia.fromFilePath(task.mediaPath);
                    }

                    let response;
                    if (mediaObj) {
                        response = await this.client.sendMessage(jid, mediaObj, { caption: task.message || '' });
                    } else {
                        response = await this.client.sendMessage(jid, task.message);
                    }
                    providerMessageId = response && response.id ? response.id._serialized : '';
                } catch (err) {
                    console.error(`Failed to send WhatsApp message to ${task.cleanPhone}:`, err.message);
                    try {
                        await db.run(`
                            INSERT INTO whatsapp_logs (lead_id, phone, message, direction, status, error_message)
                            VALUES (NULL, ?, ?, 'OUTGOING', 'FAILED', ?)
                        `, [task.rawPhone, task.message, err.message]);
                    } catch (dbErr) {
                        console.error('Warning: could not log failure to DB:', dbErr.message);
                    }
                    task.reject(err);
                    continue;
                }
            }

            // Unified DB Logging & Activity Feed update
            try {
                let validLeadId = null;
                if (task.leadId) {
                    const existing = await db.get(`SELECT id FROM leads WHERE id = ?`, [task.leadId]);
                    if (existing) validLeadId = existing.id;
                }

                await db.run(`
                    INSERT INTO whatsapp_logs (lead_id, phone, message, media_path, direction, status, provider_message_id)
                    VALUES (?, ?, ?, ?, 'OUTGOING', 'SENT', ?)
                `, [validLeadId, task.cleanPhone, task.message, task.mediaPath || '', providerMessageId]);

                if (validLeadId) {
                    const isImg = /\.(jpg|jpeg|png|webp|gif)$/i.test(task.mediaPath || '');
                    const isVid = /\.(mp4|mov|avi|m4v|3gp)$/i.test(task.mediaPath || '');
                    const mediaPrefix = isImg ? '[Attached Image] ' : (isVid ? '[Attached Video] ' : (task.mediaPath ? '[Attached Media] ' : ''));
                    const preview = mediaPrefix + (task.message || '').substring(0, 80);
                    await db.run(`
                        INSERT INTO activities (lead_id, type, title, description, metadata)
                        VALUES (?, 'WHATSAPP_SENT', 'WhatsApp Sent', ?, ?)
                    `, [validLeadId, preview, JSON.stringify({ phone: task.cleanPhone, media: !!task.mediaPath, isImage: isImg, isVideo: isVid, providerMessageId })]);

                    await db.run(`
                        UPDATE leads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
                    `, [validLeadId]);
                }
            } catch (dbErr) {
                console.error('Warning: could not write activity/log to DB:', dbErr.message);
            }

            task.resolve({ success: true, phone: task.cleanPhone, providerMessageId });

            // Anti-Ban Delay between queued messages (skipped in test sandbox)
            if (this.queue.length > 0 && !isTestEnv) {
                const randomDelay = Math.floor(Math.random() * (this.maxDelayMs - this.minDelayMs + 1)) + this.minDelayMs;
                console.log(`[WhatsApp Anti-Ban] Waiting ${randomDelay}ms before next message...`);
                await new Promise(r => setTimeout(r, randomDelay));
            }
        }

        this.isProcessingQueue = false;
    }

    async handleIncomingMessage(msg) {
        if (!msg || msg.fromMe) return;

        try {
            // Filter out WhatsApp Status/Stories, Groups, and Newsletters
            if (msg.from === 'status@broadcast' || msg.isStatus) return;
            if (msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast') || msg.from.endsWith('@newsletter')) return;
            if (!msg.from.endsWith('@c.us')) return;

            // e.g. "919876543210@c.us"
            const fromNumber = msg.from.split('@')[0];
            const body = msg.body;

            console.log(`[WhatsApp Incoming] Direct message from ${fromNumber}: ${body}`);

            // Search if phone exists in leads table (check with or without country code)
            const phoneSuffix = fromNumber.slice(-10); // last 10 digits
            const lead = await db.get(`
                SELECT * FROM leads 
                WHERE phone LIKE '%' || ? OR phone = ? LIMIT 1
            `, [phoneSuffix, fromNumber]);

            const leadId = lead ? lead.id : null;

            // Log message
            await db.run(`
                INSERT INTO whatsapp_logs (lead_id, phone, message, direction, status)
                VALUES (?, ?, ?, 'INCOMING', 'RECEIVED')
            `, [leadId, fromNumber, body]);

            if (lead) {
                // Log activity
                await db.run(`
                    INSERT INTO activities (lead_id, type, title, description)
                    VALUES (?, 'WHATSAPP_RECEIVED', 'Incoming WhatsApp Reply', ?)
                `, [lead.id, body]);

                // Increase engagement score by +5 and update stage to 'Contacted' if was 'New'
                const newStage = lead.stage === 'New' ? 'Contacted' : lead.stage;
                await db.run(`
                    UPDATE leads 
                    SET score = score + 5, stage = ?, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                `, [newStage, lead.id]);

                console.log(`Updated lead ${lead.first_name} ${lead.last_name} with incoming reply.`);
            }
        } catch (err) {
            console.error('Error handling incoming WhatsApp message:', err);
        }
    }

    // Helper to replace template variables with lead fields
    renderTemplate(content, lead) {
        if (!content || !lead) return content;
        return content
            .replace(/\{\{first_name\}\}/gi, lead.first_name || '')
            .replace(/\{\{last_name\}\}/gi, lead.last_name || '')
            .replace(/\{\{full_name\}\}/gi, `${lead.first_name || ''} ${lead.last_name || ''}`.trim())
            .replace(/\{\{phone\}\}/gi, lead.phone || '')
            .replace(/\{\{email\}\}/gi, lead.email || '')
            .replace(/\{\{company\}\}/gi, lead.company || '')
            .replace(/\{\{job_title\}\}/gi, lead.job_title || '')
            .replace(/\{\{stage\}\}/gi, lead.stage || '')
            .replace(/\{\{owner\}\}/gi, lead.owner || '');
    }
}

const service = new WhatsAppService();
module.exports = service;
