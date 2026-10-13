const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const db = require('./database');
const whatsapp = require('./whatsapp');
const whatsappLinks = require('./whatsapp_links');
const campaignManager = require('./campaign_manager');
const lsqSync = require('./leadsquared_sync');
const webhookHandler = require('./webhook_handler');
const openwa = require('./openwa_api');
const cloudApi = require('./whatsapp_cloud_api');
const complianceService = require('./compliance_service');
const consentManager = require('./consent_manager');
const complianceQueue = require('./compliance_guard_queue');

const os = require('os');
const app = express();
const PORT = process.env.PORT || 3000;

const uploadBaseDir = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'uploads')
    : (process.env.VERCEL ? path.join(os.tmpdir(), 'uploads') : path.join(__dirname, 'uploads'));

// Configure Multer for CSV file upload
if (!fs.existsSync(uploadBaseDir)) {
    try { fs.mkdirSync(uploadBaseDir, { recursive: true }); } catch (e) {}
}
const upload = multer({ dest: uploadBaseDir });

// Configure Multer for Media uploads (Video, Image, PDF)
const mediaDir = path.join(uploadBaseDir, 'media');
if (!fs.existsSync(mediaDir)) {
    try { fs.mkdirSync(mediaDir, { recursive: true }); } catch (e) {}
}

const mediaStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, mediaDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'media-' + uniqueSuffix + ext);
    }
});
const uploadMedia = multer({
    storage: mediaStorage,
    limits: { fileSize: 64 * 1024 * 1024 } // 64 MB limit for videos
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadBaseDir));
if (uploadBaseDir !== path.join(__dirname, 'uploads') && fs.existsSync(path.join(__dirname, 'uploads'))) {
    app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
}

// Cloud Health Check Endpoint (Railway / Vercel / Docker)
app.get('/api/health', async (req, res) => {
    try {
        const leadCount = await db.get('SELECT COUNT(*) as c FROM leads');
        res.json({
            status: 'ok',
            uptime: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
            environment: process.env.VERCEL ? 'vercel' : (process.env.RAILWAY_ENVIRONMENT ? 'railway' : 'self-hosted'),
            database: 'connected',
            leads: leadCount ? leadCount.c : 0,
            whatsapp: whatsapp.getStatus().status
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// Initialize database
db.initDatabase().then(() => {
    console.log('Database initialized successfully.');
}).catch(err => {
    console.error('Error initializing database:', err);
});

// Helper to trigger automations
async function triggerAutomations(triggerType, conditionValue, lead) {
    try {
        const automations = await db.all(`
            SELECT a.*, t.content as template_content, t.category as template_category
            FROM automations a
            LEFT JOIN templates t ON a.template_id = t.id
            WHERE a.trigger_type = ? AND a.is_active = 1
        `, [triggerType]);

        for (const auto of automations) {
            // Check condition (* matches all, or exact match with stage)
            if (auto.trigger_condition === '*' || auto.trigger_condition === conditionValue) {
                if (auto.action_type === 'SEND_WHATSAPP' && auto.template_content && lead.phone) {
                    const personalizedMsg = whatsapp.renderTemplate(auto.template_content, lead);
                    console.log(`[Automation Triggered] '${auto.name}' sending to ${lead.first_name} (${lead.phone})`);
                    
                    whatsapp.queueMessage({
                        leadId: lead.id,
                        phone: lead.phone,
                        message: personalizedMsg,
                        category: auto.template_category || 'MARKETING',
                        tenantId: lead.tenant_id || 'default'
                    }).catch(err => {
                        console.error(`Automation message failed for lead ${lead.id}:`, err.message);
                    });
                }
            }
        }
    } catch (err) {
        console.error('Error evaluating automations:', err);
    }
}

// ==========================================
// WHATSAPP API ROUTES
// ==========================================

// Get WhatsApp Connection Status & QR Code
app.get('/api/whatsapp/status', (req, res) => {
    res.json(whatsapp.getStatus());
});

// Start WhatsApp Client & Get QR
app.post('/api/whatsapp/connect', async (req, res) => {
    try {
        whatsapp.init(); // runs async
        res.json({ success: true, message: 'WhatsApp client initializing...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Disconnect WhatsApp
app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
        await whatsapp.disconnect();
        res.json({ success: true, message: 'WhatsApp disconnected.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reset WhatsApp Session (Unlink & generate fresh QR code)
app.post('/api/whatsapp/reset', async (req, res) => {
    try {
        const cleanPuppeteer = require('./clean_puppeteer');
        if (typeof cleanPuppeteer === 'function') cleanPuppeteer();
        if (openwa.config && openwa.config.enabled) {
            await openwa.forceResetSession();
        } else {
            await whatsapp.resetSession();
            whatsapp.init().catch(e => console.error('Reset re-init error:', e.message));
        }
        res.json({ success: true, message: 'WhatsApp session reset and locks cleared. Generating fresh QR code...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// OPENWA SELF-HOSTED GATEWAY API
// ==========================================
app.get('/api/openwa/status', (req, res) => {
    res.json(openwa.getPublicConfig());
});

app.post('/api/openwa/config', async (req, res) => {
    try {
        const updated = await openwa.updateConfig(req.body);
        res.json({ success: true, config: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/openwa/test', async (req, res) => {
    try {
        const result = await openwa.testConnection();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.get('/api/openwa/qr', async (req, res) => {
    try {
        const qr = await openwa.getQrCode();
        res.json({ success: true, ...qr });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/openwa/start', async (req, res) => {
    try {
        const result = await openwa.startSession();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/openwa/restart', async (req, res) => {
    try {
        const result = await openwa.restartSession();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/openwa/reset-session', async (req, res) => {
    try {
        const result = await openwa.forceResetSession();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/openwa/pairing-code', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'Phone number is required (e.g. 919876543210)' });
        }
        const result = await openwa.requestPairingCode(phoneNumber);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// OFFICIAL WHATSAPP CLOUD API (META)
// ==========================================
app.get('/api/whatsapp-cloud/status', (req, res) => {
    res.json(cloudApi.getPublicConfig());
});

app.post('/api/whatsapp-cloud/config', async (req, res) => {
    try {
        const updated = await cloudApi.updateConfig(req.body);
        res.json({ success: true, config: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/whatsapp-cloud/test', async (req, res) => {
    try {
        const result = await cloudApi.testConnection();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Upload Video / Image / Media Attachment
app.post('/api/upload-media', uploadMedia.single('media'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No media file provided.' });
    }
    res.json({
        success: true,
        filePath: req.file.path,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        url: `/uploads/media/${path.basename(req.file.path)}`
    });
});

// Send single WhatsApp message (Text or Video/Media + Caption)
app.post('/api/whatsapp/send', async (req, res) => {
    const { leadId, phone, message, mediaPath } = req.body;
    if (!phone || (!message && !mediaPath)) {
        return res.status(400).json({ error: 'Phone and either message or media are required.' });
    }

    try {
        whatsapp.queueMessage({ leadId, phone, message, mediaPath });
        res.json({ success: true, message: 'Message added to sending queue.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get recent WhatsApp message logs
app.get('/api/whatsapp/logs', async (req, res) => {
    try {
        const logs = await db.all(`
            SELECT w.*, l.first_name, l.last_name, l.company 
            FROM whatsapp_logs w
            LEFT JOIN leads l ON w.lead_id = l.id
            ORDER BY w.created_at DESC
            LIMIT 50
        `);
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// DASHBOARD & ANALYTICS
// ==========================================
app.get('/api/dashboard', async (req, res) => {
    try {
        const totalLeads = await db.get(`SELECT COUNT(*) as count FROM leads`);
        const stageCounts = await db.all(`
            SELECT stage, COUNT(*) as count FROM leads GROUP BY stage
        `);
        const wonCount = await db.get(`SELECT COUNT(*) as count FROM leads WHERE stage = 'Won'`);
        const totalSent = await db.get(`SELECT COUNT(*) as count FROM whatsapp_logs WHERE direction = 'OUTGOING' AND status = 'SENT'`);
        const totalReceived = await db.get(`SELECT COUNT(*) as count FROM whatsapp_logs WHERE direction = 'INCOMING'`);
        
        const recentActivities = await db.all(`
            SELECT a.*, l.first_name, l.last_name, l.company 
            FROM activities a
            LEFT JOIN leads l ON a.lead_id = l.id
            ORDER BY a.created_at DESC
            LIMIT 10
        `);

        const conversionRate = totalLeads.count > 0 ? ((wonCount.count / totalLeads.count) * 100).toFixed(1) : 0;

        res.json({
            stats: {
                totalLeads: totalLeads.count,
                wonLeads: wonCount.count,
                conversionRate: `${conversionRate}%`,
                messagesSent: totalSent.count,
                messagesReceived: totalReceived.count
            },
            stages: stageCounts,
            recentActivities
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// LEADS API (LeadSquared Core)
// ==========================================

// Get Leads with filtering, searching, and pagination + Compliance & Consent status
app.get('/api/leads', async (req, res) => {
    try {
        const { stage, priority, source, search, limit = 100, offset = 0 } = req.query;
        let query = `
            SELECT l.*,
                   (SELECT c.status FROM whatsapp_consents c WHERE c.contact_phone = l.phone AND c.tenant_id = COALESCE(l.tenant_id, 'default') ORDER BY CASE WHEN c.status = 'OPTED_IN' THEN 0 ELSE 1 END, c.updated_at DESC LIMIT 1) as consent_status,
                   (SELECT c.purpose FROM whatsapp_consents c WHERE c.contact_phone = l.phone AND c.tenant_id = COALESCE(l.tenant_id, 'default') ORDER BY CASE WHEN c.status = 'OPTED_IN' THEN 0 ELSE 1 END, c.updated_at DESC LIMIT 1) as consent_purpose,
                   (SELECT c.source FROM whatsapp_consents c WHERE c.contact_phone = l.phone AND c.tenant_id = COALESCE(l.tenant_id, 'default') ORDER BY CASE WHEN c.status = 'OPTED_IN' THEN 0 ELSE 1 END, c.updated_at DESC LIMIT 1) as consent_source,
                   (SELECT COUNT(*) FROM whatsapp_suppressions s WHERE s.contact_phone = l.phone AND s.tenant_id = COALESCE(l.tenant_id, 'default')) as suppression_count
            FROM leads l
            WHERE 1=1
        `;
        const params = [];

        if (stage && stage !== 'ALL') {
            query += ` AND l.stage = ?`;
            params.push(stage);
        }
        if (priority && priority !== 'ALL') {
            query += ` AND l.priority = ?`;
            params.push(priority);
        }
        if (source && source !== 'ALL') {
            query += ` AND l.source = ?`;
            params.push(source);
        }
        if (search) {
            query += ` AND (l.first_name LIKE ? OR l.last_name LIKE ? OR l.phone LIKE ? OR l.company LIKE ? OR l.email LIKE ?)`;
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam, searchParam, searchParam, searchParam);
        }

        query += ` ORDER BY l.updated_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const leads = await db.all(query, params);
        res.json(leads);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export Leads to CSV / Excel (Defined before /api/leads/:id so Express does not capture 'export' as an ID)
app.get('/api/leads/export', async (req, res) => {
    try {
        const leads = await db.all(`SELECT * FROM leads ORDER BY id ASC`);
        // UTF-8 Byte Order Mark (\uFEFF) ensures Excel automatically detects UTF-8 encoding and parses commas/special characters
        let csvContent = '\uFEFFID,First Name,Last Name,Email,Phone,Company,Stage,Source,Priority,Score,Opted Out,LeadSquared ID,Created At\n';

        for (const l of leads) {
            const row = [
                l.id,
                `"${(l.first_name || '').replace(/"/g, '""')}"`,
                `"${(l.last_name || '').replace(/"/g, '""')}"`,
                `"${(l.email || '').replace(/"/g, '""')}"`,
                `"${(l.phone || '').replace(/"/g, '""')}"`,
                `"${(l.company || '').replace(/"/g, '""')}"`,
                `"${(l.stage || '').replace(/"/g, '""')}"`,
                `"${(l.source || '').replace(/"/g, '""')}"`,
                `"${(l.priority || '').replace(/"/g, '""')}"`,
                l.score || 0,
                l.opted_out ? 'Yes' : 'No',
                `"${(l.leadsquared_id || '').replace(/"/g, '""')}"`,
                `"${(l.created_at || '').replace(/"/g, '""')}"`
            ].join(',');
            csvContent += row + '\n';
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="leadsquared_leads_export.csv"');
        res.send(csvContent);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Single Lead with full 360 degree profile + Compliance History
app.get('/api/leads/:id', async (req, res) => {
    try {
        if (req.params.id === 'export') {
            return res.redirect('/api/leads/export');
        }
        const lead = await db.get(`SELECT * FROM leads WHERE id = ?`, [req.params.id]);
        if (!lead) return res.status(404).json({ error: 'Lead not found.' });

        const activities = await db.all(`
            SELECT * FROM activities WHERE lead_id = ? ORDER BY created_at DESC
        `, [lead.id]);

        const messages = await db.all(`
            SELECT * FROM whatsapp_logs WHERE lead_id = ? OR phone LIKE '%' || ? ORDER BY created_at ASC
        `, [lead.id, lead.phone.slice(-10)]);

        const consents = await consentManager.getAllConsentsForPhone(lead.tenant_id || 'default', lead.phone);
        const complianceHistory = await consentManager.getConsentHistory(lead.tenant_id || 'default', lead.phone);

        res.json({ lead, activities, messages, consents, complianceHistory });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create New Lead
app.post('/api/leads', async (req, res) => {
    try {
        const {
            first_name,
            last_name = '',
            email = '',
            phone,
            company = '',
            job_title = '',
            stage = 'New',
            source = 'Manual Entry',
            priority = 'Medium',
            score = 15,
            notes = '',
            tags = '',
            whatsapp_consent,
            consent_purpose = 'MARKETING'
        } = req.body;

        if (!first_name || !phone) {
            return res.status(400).json({ error: 'First name and phone number are required.' });
        }

        const cleanPhone = whatsapp.cleanPhoneNumber(phone);

        const result = await db.run(`
            INSERT INTO leads (first_name, last_name, email, phone, company, job_title, stage, source, priority, score, notes, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [first_name, last_name, email, cleanPhone, company, job_title, stage, source, priority, score, notes, tags]);

        const newLeadId = result.lastID;

        // Log lead creation activity
        await db.run(`
            INSERT INTO activities (lead_id, type, title, description)
            VALUES (?, 'LEAD_CREATED', 'Lead Created', ?)
        `, [newLeadId, `Created with status '${stage}' from source '${source}'`]);

        // Record WhatsApp Consent if granted in Lead form
        if (whatsapp_consent === true || whatsapp_consent === 'true' || whatsapp_consent === 1) {
            try {
                await consentManager.captureConsent({
                    tenantId: 'default',
                    phone: cleanPhone,
                    leadId: newLeadId,
                    purpose: ['MARKETING', 'TRANSACTIONAL', 'CUSTOMER_SERVICE'].includes(consent_purpose) ? consent_purpose : 'MARKETING',
                    status: 'OPTED_IN',
                    source: source || 'WEB_FORM',
                    collectionMethod: 'WEB_FORM',
                    consentEvidence: JSON.stringify({
                        form: 'CRM Lead Creation Modal',
                        leadName: `${first_name} ${last_name}`.trim(),
                        capturedAt: new Date().toISOString()
                    }),
                    actorId: 'crm_user',
                    actorRole: 'ADMIN',
                    reason: 'Affirmative WhatsApp consent captured during lead creation'
                });
            } catch (ce) {
                console.warn('[Lead Consent Capture Note]', ce.message);
            }
        }

        const createdLead = await db.get(`SELECT * FROM leads WHERE id = ?`, [newLeadId]);

        // Evaluate automated triggers (after consent is recorded so Compliance Guard sees the consent)
        triggerAutomations('ON_LEAD_CREATED', stage, createdLead);

        // Enqueue LeadSquared CRM synchronization
        lsqSync.enqueueLead(newLeadId, 'CREATE').catch(e => console.error('[LSQ Sync Error]', e.message));

        res.status(201).json(createdLead);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update Lead
app.put('/api/leads/:id', async (req, res) => {
    try {
        const leadId = req.params.id;
        const existingLead = await db.get(`SELECT * FROM leads WHERE id = ?`, [leadId]);
        if (!existingLead) return res.status(404).json({ error: 'Lead not found.' });

        const {
            first_name = existingLead.first_name,
            last_name = existingLead.last_name,
            email = existingLead.email,
            phone = existingLead.phone,
            company = existingLead.company,
            job_title = existingLead.job_title,
            stage = existingLead.stage,
            source = existingLead.source,
            priority = existingLead.priority,
            score = existingLead.score,
            notes = existingLead.notes,
            tags = existingLead.tags,
            opted_out = existingLead.opted_out,
            whatsapp_consent,
            consent_purpose = 'MARKETING'
        } = req.body;

        const cleanPhone = whatsapp.cleanPhoneNumber(phone);

        await db.run(`
            UPDATE leads 
            SET first_name = ?, last_name = ?, email = ?, phone = ?, company = ?, job_title = ?, stage = ?, source = ?, priority = ?, score = ?, notes = ?, tags = ?, opted_out = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [first_name, last_name, email, cleanPhone, company, job_title, stage, source, priority, score, notes, tags, opted_out ? 1 : 0, leadId]);

        if (whatsapp_consent === true || whatsapp_consent === 'true' || whatsapp_consent === 1) {
            try {
                await consentManager.captureConsent({
                    tenantId: existingLead.tenant_id || 'default',
                    phone: cleanPhone,
                    leadId: Number(leadId),
                    purpose: ['MARKETING', 'TRANSACTIONAL', 'CUSTOMER_SERVICE'].includes(consent_purpose) ? consent_purpose : 'MARKETING',
                    status: 'OPTED_IN',
                    source: source || 'WEB_FORM',
                    collectionMethod: 'WEB_FORM',
                    consentEvidence: JSON.stringify({
                        form: 'CRM Lead Edit Modal',
                        leadName: `${first_name} ${last_name}`.trim(),
                        capturedAt: new Date().toISOString()
                    }),
                    actorId: 'crm_user',
                    actorRole: 'ADMIN',
                    reason: 'Affirmative WhatsApp consent updated on lead profile'
                });
            } catch (ce) {}
        }

        // Check if stage changed
        if (existingLead.stage !== stage) {
            await db.run(`
                INSERT INTO activities (lead_id, type, title, description)
                VALUES (?, 'STAGE_CHANGED', 'Stage Updated', ?)
            `, [leadId, `Stage changed from '${existingLead.stage}' to '${stage}'`]);

            const updatedLead = await db.get(`SELECT * FROM leads WHERE id = ?`, [leadId]);
            triggerAutomations('ON_STAGE_CHANGED', stage, updatedLead);
        }

        // Enqueue LeadSquared CRM update
        lsqSync.enqueueLead(leadId, 'UPDATE').catch(e => console.error('[LSQ Sync Error]', e.message));

        const finalLead = await db.get(`SELECT * FROM leads WHERE id = ?`, [leadId]);
        res.json(finalLead);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle Lead Opt-Out / Consent (Synchronized with Global Suppression & Consent Guard)
app.post('/api/leads/:id/opt-out', async (req, res) => {
    try {
        const lead = await db.get(`SELECT * FROM leads WHERE id = ?`, [req.params.id]);
        if (!lead) return res.status(404).json({ error: 'Lead not found.' });

        const newStatus = lead.opted_out ? 0 : 1;
        await db.run(`UPDATE leads SET opted_out = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [newStatus, req.params.id]);

        const tenantId = lead.tenant_id || 'default';
        if (newStatus === 1) {
            try {
                await consentManager.addSuppression({
                    tenantId,
                    phone: lead.phone,
                    reason: 'CRM Lead Opt-Out Toggle',
                    scope: 'GLOBAL',
                    actorId: 'crm_user',
                    actorRole: 'ADMIN'
                });
                await consentManager.revokeConsent({
                    tenantId,
                    phone: lead.phone,
                    purpose: 'MARKETING',
                    reason: 'CRM Lead Opt-Out Toggle',
                    actorId: 'crm_user',
                    actorRole: 'ADMIN'
                });
            } catch (e) {}
        } else {
            try {
                await consentManager.removeSuppression({
                    tenantId,
                    phone: lead.phone,
                    scope: 'GLOBAL',
                    actorId: 'crm_user',
                    actorRole: 'ADMIN'
                });
                await consentManager.captureConsent({
                    tenantId,
                    phone: lead.phone,
                    leadId: lead.id,
                    purpose: 'MARKETING',
                    status: 'OPTED_IN',
                    source: 'WEB_FORM',
                    collectionMethod: 'WEB_FORM',
                    consentEvidence: JSON.stringify({ action: 'Re-subscribed via Lead Table toggle', timestamp: new Date().toISOString() }),
                    actorId: 'crm_user',
                    actorRole: 'ADMIN',
                    reason: 'Lead re-subscribed via CRM toggle'
                });
            } catch (e) {}
        }

        await db.run(`
            INSERT INTO activities (lead_id, type, title, description)
            VALUES (?, 'OPT_OUT_CHANGED', 'Opt-out Preference Updated', ?)
        `, [req.params.id, newStatus ? 'Recipient marked as Opted Out (Added to Global Suppression List).' : 'Recipient re-subscribed (Consent OPTED_IN restored).']);

        res.json({ success: true, opted_out: newStatus });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger Manual LeadSquared Sync for single lead
app.post('/api/leads/:id/sync', async (req, res) => {
    try {
        const result = await lsqSync.enqueueLead(req.params.id, 'UPDATE');
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete All Leads (Bulk Clear)
app.delete('/api/leads', async (req, res) => {
    try {
        await db.run('DELETE FROM activities');
        await db.run('DELETE FROM leadsquared_sync_queue');
        await db.run('DELETE FROM campaign_recipients');
        const result = await db.run('DELETE FROM leads');
        await db.run("INSERT OR REPLACE INTO leadsquared_config (key, value) VALUES ('demo_leads_seeded', '1')");
        try {
            await db.run("DELETE FROM sqlite_sequence WHERE name IN ('leads', 'activities', 'leadsquared_sync_queue', 'campaign_recipients')");
        } catch (e) {}
        await db.run('VACUUM;');
        res.json({ success: true, message: `All leads and associated activities cleared (${result.changes} leads removed).` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Single Lead
app.delete('/api/leads/:id', async (req, res) => {
    try {
        await db.run(`DELETE FROM leads WHERE id = ?`, [req.params.id]);
        res.json({ success: true, message: 'Lead deleted successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add Note / Activity to Lead
app.post('/api/leads/:id/notes', async (req, res) => {
    try {
        const { note } = req.body;
        if (!note) return res.status(400).json({ error: 'Note content is required.' });

        await db.run(`
            INSERT INTO activities (lead_id, type, title, description)
            VALUES (?, 'NOTE_ADDED', 'Note Added', ?)
        `, [req.params.id, note]);

        await db.run(`UPDATE leads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id]);

        res.json({ success: true, message: 'Note logged successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Import Leads from CSV
app.post('/api/leads/import', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No CSV file uploaded.' });
    }

    const results = [];
    const filePath = req.file.path;

    fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            fs.unlinkSync(filePath); // delete temp file

            let importedCount = 0;
            for (const row of results) {
                // Find matching column names flexibly
                const firstName = row.first_name || row['First Name'] || row.Name || row.name || 'Lead';
                const lastName = row.last_name || row['Last Name'] || '';
                const phone = row.phone || row['Phone'] || row['Mobile'] || row['WhatsApp'] || '';
                const email = row.email || row['Email'] || '';
                const company = row.company || row['Company'] || row['Organization'] || '';
                const stage = row.stage || row['Stage'] || 'New';
                const source = row.source || row['Source'] || 'CSV Import';

                if (phone) {
                    const cleanPhone = whatsapp.cleanPhoneNumber(phone);
                    try {
                        const r = await db.run(`
                            INSERT INTO leads (first_name, last_name, email, phone, company, stage, source)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        `, [firstName, lastName, email, cleanPhone, company, stage, source]);
                        
                        await db.run(`
                            INSERT INTO activities (lead_id, type, title, description)
                            VALUES (?, 'LEAD_CREATED', 'Imported via CSV', 'Batch upload')
                        `, [r.lastID]);

                        importedCount++;
                    } catch (e) {
                        console.error('Error importing row:', e.message);
                    }
                }
            }

            res.json({ success: true, imported: importedCount, total: results.length });
        })
        .on('error', (err) => {
            res.status(500).json({ error: 'Failed to parse CSV file: ' + err.message });
        });
});

// ==========================================
// TEMPLATES API
// ==========================================
app.get('/api/templates', async (req, res) => {
    try {
        const templates = await db.all(`SELECT * FROM templates ORDER BY id DESC`);
        res.json(templates);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/templates', async (req, res) => {
    try {
        const { name, category = 'General', content } = req.body;
        if (!name || !content) return res.status(400).json({ error: 'Name and content are required.' });

        const result = await db.run(`
            INSERT INTO templates (name, category, content) VALUES (?, ?, ?)
        `, [name, category, content]);

        res.status(201).json({ id: result.lastID, name, category, content });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/templates/:id', async (req, res) => {
    try {
        const { name, category, content } = req.body;
        await db.run(`
            UPDATE templates SET name = ?, category = ?, content = ? WHERE id = ?
        `, [name, category, content, req.params.id]);
        res.json({ success: true, message: 'Template updated.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/templates/:id', async (req, res) => {
    try {
        await db.run(`DELETE FROM templates WHERE id = ?`, [req.params.id]);
        res.json({ success: true, message: 'Template deleted.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// AUTOMATIONS API (LeadSquared Triggers)
// ==========================================
app.get('/api/automations', async (req, res) => {
    try {
        const automations = await db.all(`
            SELECT a.*, t.name as template_name, t.content as template_content 
            FROM automations a
            LEFT JOIN templates t ON a.template_id = t.id
            ORDER BY a.id ASC
        `);
        res.json(automations);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/automations', async (req, res) => {
    try {
        const { name, trigger_type, trigger_condition = '*', template_id } = req.body;
        if (!name || !trigger_type || !template_id) {
            return res.status(400).json({ error: 'Name, trigger type, and template are required.' });
        }

        const result = await db.run(`
            INSERT INTO automations (name, trigger_type, trigger_condition, action_type, template_id, is_active)
            VALUES (?, ?, ?, 'SEND_WHATSAPP', ?, 1)
        `, [name, trigger_type, trigger_condition, template_id]);

        res.status(201).json({ id: result.lastID, name, trigger_type, trigger_condition, template_id, is_active: 1 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/automations/:id/toggle', async (req, res) => {
    try {
        const auto = await db.get(`SELECT is_active FROM automations WHERE id = ?`, [req.params.id]);
        if (!auto) return res.status(404).json({ error: 'Automation not found.' });

        const newState = auto.is_active ? 0 : 1;
        await db.run(`UPDATE automations SET is_active = ? WHERE id = ?`, [newState, req.params.id]);
        res.json({ success: true, is_active: newState });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/automations/:id', async (req, res) => {
    try {
        await db.run(`DELETE FROM automations WHERE id = ?`, [req.params.id]);
        res.json({ success: true, message: 'Automation deleted.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// WHATSAPP LINKS & CLICK-TO-WHATSAPP API
// ==========================================
app.post('/api/links', async (req, res) => {
    try {
        const { phone, message, campaignId, leadId, customSlug } = req.body;
        const link = await whatsappLinks.createTrackedLink({
            phone,
            message,
            campaignId,
            leadId,
            customSlug
        });
        res.status(201).json(link);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/links', async (req, res) => {
    try {
        const links = await db.all(`
            SELECT l.*, c.name as campaign_name, ld.first_name, ld.last_name 
            FROM whatsapp_links l
            LEFT JOIN campaigns c ON l.campaign_id = c.id
            LEFT JOIN leads ld ON l.lead_id = ld.id
            ORDER BY l.created_at DESC
        `);
        res.json(links);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Public Click-to-WhatsApp Redirect Handler
app.get('/l/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        const referrer = req.get('Referrer') || '';
        const userAgent = req.get('User-Agent') || '';
        const ip = req.ip || req.connection.remoteAddress || '';

        const result = await whatsappLinks.recordLinkClick(slug, { referrer, userAgent, ip });
        if (!result.found || !result.destinationUrl) {
            return res.status(404).send('WhatsApp link not found or expired.');
        }

        // Safe 302 Redirect to WhatsApp wa.me destination
        res.redirect(302, result.destinationUrl);
    } catch (err) {
        res.status(500).send('Redirection error: ' + err.message);
    }
});

app.get('/api/links/:id/analytics', async (req, res) => {
    try {
        const analytics = await whatsappLinks.getLinkAnalytics(req.params.id);
        if (!analytics) return res.status(404).json({ error: 'Link not found.' });
        res.json(analytics);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// CAMPAIGN LIFECYCLE MANAGEMENT API
// ==========================================
app.get('/api/campaigns', async (req, res) => {
    try {
        const campaigns = await db.all(`
            SELECT c.*, t.name as template_name 
            FROM campaigns c
            LEFT JOIN templates t ON c.template_id = t.id
            ORDER BY c.created_at DESC
        `);

        const enriched = campaigns.map(c => {
            let isCoolingDown = false;
            let cooldownSecondsRemaining = 0;
            if (c.cooldown_until && c.status === 'Running') {
                const untilTime = new Date(c.cooldown_until).getTime();
                const nowTime = Date.now();
                if (untilTime > nowTime) {
                    isCoolingDown = true;
                    cooldownSecondsRemaining = Math.ceil((untilTime - nowTime) / 1000);
                }
            }
            return {
                ...c,
                is_cooling_down: isCoolingDown,
                cooldown_seconds_remaining: cooldownSecondsRemaining
            };
        });

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/campaigns/:id', async (req, res) => {
    try {
        const campaign = await campaignManager.getCampaign(req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
        res.json(campaign);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/campaigns', async (req, res) => {
    try {
        const {
            name,
            targetStage = 'ALL',
            templateId,
            customMessage,
            mediaPath,
            scheduledAt,
            isDraft = false,
            minDelaySeconds = 60,
            maxDelaySeconds = 120,
            batchSize = 25,
            batchDelayMinutes = 10
        } = req.body;

        const campaign = await campaignManager.createCampaign({
            name,
            targetStage,
            templateId,
            customMessage,
            mediaPath,
            scheduledAt,
            isDraft,
            minDelaySeconds,
            maxDelaySeconds,
            batchSize,
            batchDelayMinutes
        });

        res.status(201).json(campaign);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Legacy / Quick broadcast wrapper
app.post('/api/campaigns/broadcast', async (req, res) => {
    try {
        const {
            name,
            targetStage = 'ALL',
            templateId,
            customMessage,
            mediaPath,
            minDelaySeconds = 60,
            maxDelaySeconds = 120,
            batchSize = 25,
            batchDelayMinutes = 10
        } = req.body;

        const campaign = await campaignManager.createCampaign({
            name,
            targetStage,
            templateId,
            customMessage,
            mediaPath,
            minDelaySeconds,
            maxDelaySeconds,
            batchSize,
            batchDelayMinutes
        });
        res.json({
            success: true,
            campaignId: campaign.id,
            targetCount: campaign.total_leads,
            message: `Campaign #${campaign.id} created! Batch Anti-Ban Mode: sending in batches of ${campaign.batch_size} leads with ${campaign.batch_delay_minutes} min rest gap.`
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/campaigns/:id/start', async (req, res) => {
    try {
        const result = await campaignManager.startCampaign(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/campaigns/:id/pause', async (req, res) => {
    try {
        const result = await campaignManager.pauseCampaign(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/campaigns/:id/resume', async (req, res) => {
    try {
        const result = await campaignManager.resumeCampaign(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/campaigns/:id/skip-cooldown', async (req, res) => {
    try {
        const result = await campaignManager.skipCooldown(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/campaigns/:id/cancel', async (req, res) => {
    try {
        const result = await campaignManager.cancelCampaign(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/campaigns/:id/retry', async (req, res) => {
    try {
        const result = await campaignManager.retryFailed(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ==========================================
// LEADSQUARED CRM INTEGRATION API
// ==========================================
app.get('/api/leadsquared/status', async (req, res) => {
    try {
        const status = await lsqSync.getSyncStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/leadsquared/config', async (req, res) => {
    try {
        const updated = await lsqSync.updateConfig(req.body);
        res.json({ success: true, config: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/leadsquared/sync-now', async (req, res) => {
    try {
        await lsqSync.processQueue();
        const status = await lsqSync.getSyncStatus();
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// WHATSAPP COMPLIANCE & MESSAGING GUARD API
// ==========================================
app.use('/api/compliance', (req, res, next) => {
    req.tenantId = req.headers['x-tenant-id'] || 'default';
    req.userRole = (req.headers['x-user-role'] || req.headers['x-role'] || 'ADMIN').toUpperCase();
    req.userId = req.headers['x-user-id'] || 'system_admin';
    next();
});

// Campaign Preflight Assessment
app.post('/api/compliance/preflight', async (req, res) => {
    try {
        const { targetStage, templateId, customMessage, category, providerType } = req.body;
        const result = await campaignManager.preflightCampaign({
            targetStage: targetStage || 'ALL',
            templateId: templateId || null,
            customMessage: customMessage || '',
            category: category || 'MARKETING',
            tenantId: req.tenantId,
            providerType: providerType || 'CLOUD_API'
        });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Get Consents (Paginated & Filterable)
app.get('/api/compliance/consents', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        const { purpose, status, search } = req.query;

        let where = ['c.tenant_id = ?'];
        let params = [req.tenantId];

        if (purpose) {
            where.push('c.purpose = ?');
            params.push(purpose);
        }
        if (status) {
            where.push('c.status = ?');
            params.push(status);
        }
        if (search) {
            where.push('(c.contact_phone LIKE ? OR l.first_name LIKE ? OR l.last_name LIKE ?)');
            const s = `%${search}%`;
            params.push(s, s, s);
        }

        const whereSql = where.join(' AND ');
        const countRow = await db.get(`
            SELECT COUNT(*) as total 
            FROM whatsapp_consents c
            LEFT JOIN leads l ON c.lead_id = l.id
            WHERE ${whereSql}
        `, params);

        const rows = await db.all(`
            SELECT c.*, l.first_name, l.last_name, l.email, l.company
            FROM whatsapp_consents c
            LEFT JOIN leads l ON c.lead_id = l.id
            WHERE ${whereSql}
            ORDER BY c.id DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        res.json({
            success: true,
            total: countRow ? countRow.total : 0,
            page,
            limit,
            consents: rows
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Capture Consent (Affirmative Opt-in)
app.post('/api/compliance/consents/capture', async (req, res) => {
    try {
        const { phone, leadId, purpose, status, source, collectionMethod, consentEvidence, validUntil, reason } = req.body;
        const result = await consentManager.captureConsent({
            tenantId: req.tenantId,
            phone,
            leadId,
            purpose,
            status,
            source,
            collectionMethod,
            consentEvidence,
            validUntil,
            actorId: req.userId,
            actorRole: req.userRole,
            reason
        });
        res.json({ success: true, consent: result });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Revoke Consent
app.post('/api/compliance/consents/revoke', async (req, res) => {
    try {
        const { phone, purpose, reason } = req.body;
        const result = await consentManager.revokeConsent({
            tenantId: req.tenantId,
            phone,
            purpose,
            reason,
            actorId: req.userId,
            actorRole: req.userRole
        });
        res.json({ success: true, result });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Contact Consent & Audit History
app.get('/api/compliance/consents/history', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ error: 'Phone number is required.' });
        const history = await consentManager.getConsentHistory(req.tenantId, phone);
        const consents = await consentManager.getAllConsentsForPhone(req.tenantId, phone);
        res.json({ success: true, consents, history });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// List Suppressions
app.get('/api/compliance/suppressions', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const { search } = req.query;
        const data = await consentManager.listSuppressions({
            tenantId: req.tenantId,
            page,
            limit,
            search
        });
        res.json({ success: true, ...data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Add Suppression (RBAC: ADMIN, COMPLIANCE_OFFICER)
app.post('/api/compliance/suppressions', async (req, res) => {
    try {
        const { phone, reason, scope, evidence } = req.body;
        const result = await consentManager.addSuppression({
            tenantId: req.tenantId,
            phone,
            reason,
            scope,
            evidence,
            actorId: req.userId,
            actorRole: req.userRole
        });
        res.json({ success: true, ...result });
    } catch (err) {
        const statusCode = err.message.includes('Unauthorized') ? 403 : 400;
        res.status(statusCode).json({ success: false, error: err.message });
    }
});

// Remove Suppression (RBAC: ADMIN, COMPLIANCE_OFFICER)
app.delete('/api/compliance/suppressions', async (req, res) => {
    try {
        const phone = req.query.phone || (req.body && req.body.phone);
        const scope = req.query.scope || (req.body && req.body.scope) || 'GLOBAL';
        const result = await consentManager.removeSuppression({
            tenantId: req.tenantId,
            phone,
            scope,
            actorId: req.userId,
            actorRole: req.userRole
        });
        res.json({ success: true, ...result });
    } catch (err) {
        const statusCode = err.message.includes('Unauthorized') ? 403 : 400;
        res.status(statusCode).json({ success: false, error: err.message });
    }
});

// Compliance Audit Logs Query
app.get('/api/compliance/audit-logs', async (req, res) => {
    try {
        const { page, limit, action, status, search, startDate, endDate } = req.query;
        const logs = await complianceService.getAuditLogs({
            tenantId: req.tenantId,
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 50,
            action,
            status,
            search,
            startDate,
            endDate
        });
        res.json({ success: true, ...logs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Export Compliance Audit Logs CSV
app.get('/api/compliance/audit-logs/export', async (req, res) => {
    try {
        const csvContent = await complianceService.exportAuditLogsCsv(req.tenantId);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="compliance_audit_logs.csv"');
        res.send(csvContent);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Compliance Policy Settings
app.get('/api/compliance/settings', async (req, res) => {
    try {
        const settings = await complianceService.getTenantSettings(req.tenantId);
        res.json({ success: true, settings });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update Compliance Settings (RBAC: ADMIN, COMPLIANCE_OFFICER)
const handleUpdateComplianceSettings = async (req, res) => {
    try {
        const updated = await complianceService.updateTenantSettings(req.tenantId, req.body, req.userRole);
        res.json({ success: true, settings: updated });
    } catch (err) {
        const statusCode = err.message.includes('Unauthorized') ? 403 : 400;
        res.status(statusCode).json({ success: false, error: err.message });
    }
};
app.put('/api/compliance/settings', handleUpdateComplianceSettings);
app.post('/api/compliance/settings', handleUpdateComplianceSettings);

// Compliance KPI Overview Stats
app.get('/api/compliance/stats', async (req, res) => {
    try {
        const totalConsents = await db.get(`SELECT COUNT(*) as c FROM whatsapp_consents WHERE tenant_id = ?`, [req.tenantId]);
        const optedIn = await db.get(`SELECT COUNT(*) as c FROM whatsapp_consents WHERE tenant_id = ? AND status = 'OPTED_IN'`, [req.tenantId]);
        const suppressions = await db.get(`SELECT COUNT(*) as c FROM whatsapp_suppressions WHERE tenant_id = ?`, [req.tenantId]);
        const blockedDispatches = await db.get(`SELECT COUNT(*) as c FROM compliance_audit_logs WHERE tenant_id = ? AND action = 'DISPATCH_BLOCKED'`, [req.tenantId]);
        const approvedDispatches = await db.get(`SELECT COUNT(*) as c FROM compliance_audit_logs WHERE tenant_id = ? AND action = 'DISPATCH_APPROVED'`, [req.tenantId]);

        res.json({
            success: true,
            totalConsents: totalConsents ? totalConsents.c : 0,
            activeOptedIn: optedIn ? optedIn.c : 0,
            suppressedContacts: suppressions ? suppressions.c : 0,
            blockedDispatches: blockedDispatches ? blockedDispatches.c : 0,
            approvedDispatches: approvedDispatches ? approvedDispatches.c : 0
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// WHATSAPP WEBHOOKS API
// ==========================================
app.get('/api/webhooks/whatsapp', (req, res) => {
    webhookHandler.handleVerification(req, res);
});

app.post('/api/webhooks/whatsapp', async (req, res) => {
    await webhookHandler.processWebhook(req, res);
});

// Process safety: Prevent uncaught errors from crashing server
process.on('uncaughtException', (err) => {
    console.error('Unhandled Exception caught:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection caught:', reason);
});

// Start Server (skip app.listen when imported by Vercel serverless runtime)
if (!process.env.VERCEL && require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`====================================================`);
        console.log(`🚀 LeadSquared Clone CRM with WhatsApp Automation`);
        console.log(`🌐 Server running at: http://localhost:${PORT}`);
        console.log(`📱 WhatsApp Engine ready. Scan QR in web dashboard.`);
        console.log(`====================================================`);

        // Auto-resume existing WhatsApp session if user previously paired
        const authDir = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authDir)) {
            console.log('Saved WhatsApp session detected. Resuming automatically...');
            whatsapp.init().catch(e => console.error('Auto-resume failed:', e.message));
        }
    });
}

// Process cleanup on exit: prevent orphaned Puppeteer browser processes
const shutdownHandler = async () => {
    console.log('Shutting down server gracefully...');
    try {
        await whatsapp.disconnect();
    } catch (e) {}
    process.exit(0);
};

process.on('SIGINT', shutdownHandler);
process.on('SIGTERM', shutdownHandler);

module.exports = app;


