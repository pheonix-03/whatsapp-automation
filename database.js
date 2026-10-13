const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const os = require('os');

const isTestEnv = process.env.NODE_ENV === 'test' ||
                  process.argv.some(a => a === '--test' || a.endsWith('.test.js') || a.includes('tests/')) ||
                  process.execArgv.some(a => a === '--test' || a.startsWith('--test-'));

let baseDataDir = process.env.DATA_DIR || __dirname;
if (process.env.VERCEL && !process.env.DATA_DIR) {
    baseDataDir = os.tmpdir();
}
if (!fs.existsSync(baseDataDir)) {
    try { fs.mkdirSync(baseDataDir, { recursive: true }); } catch (e) {}
}

const dbFileName = isTestEnv ? 'leadsquared.test.db' : 'leadsquared.db';
const dbPath = path.join(baseDataDir, dbFileName);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Failed to open database:', err.message);
    } else {
        console.log('Connected to SQLite database at', dbPath);
    }
});

// Configure 10-second busy timeout to avoid SQLITE_BUSY when multiple workers or test runners access the DB
db.configure('busyTimeout', 10000);

// Helper for promise-based queries
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

// Initialize tables and seed default data
async function initDatabase() {
    await run(`PRAGMA foreign_keys = ON;`);
    await run(`PRAGMA journal_mode = WAL;`);
    await run(`PRAGMA busy_timeout = 10000;`);

    // Leads Table
    await run(`
        CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT NOT NULL,
            last_name TEXT DEFAULT '',
            email TEXT DEFAULT '',
            phone TEXT NOT NULL,
            company TEXT DEFAULT '',
            job_title TEXT DEFAULT '',
            stage TEXT DEFAULT 'New', -- New, Contacted, Qualified, Proposal Sent, Won, Lost
            source TEXT DEFAULT 'Website', -- Website, Referral, WhatsApp, Call, Ad Campaign
            score INTEGER DEFAULT 10,
            priority TEXT DEFAULT 'Medium', -- Low, Medium, High
            owner TEXT DEFAULT 'Sales Agent',
            notes TEXT DEFAULT '',
            tags TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Activities / Timeline Table
    await run(`
        CREATE TABLE IF NOT EXISTS activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id INTEGER,
            type TEXT NOT NULL, -- LEAD_CREATED, STAGE_CHANGED, WHATSAPP_SENT, WHATSAPP_RECEIVED, NOTE_ADDED
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            metadata TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE CASCADE
        );
    `);

    // Templates Table
    await run(`
        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT DEFAULT 'General',
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Automations Table
    await run(`
        CREATE TABLE IF NOT EXISTS automations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            trigger_type TEXT NOT NULL, -- ON_LEAD_CREATED, ON_STAGE_CHANGED
            trigger_condition TEXT DEFAULT '*', -- '*' or specific stage like 'Qualified'
            action_type TEXT DEFAULT 'SEND_WHATSAPP',
            template_id INTEGER,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (template_id) REFERENCES templates (id) ON DELETE SET NULL
        );
    `);

    // Broadcast Campaigns Table
    await run(`
        CREATE TABLE IF NOT EXISTS campaigns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            template_id INTEGER,
            target_stage TEXT DEFAULT 'ALL',
            total_leads INTEGER DEFAULT 0,
            sent_count INTEGER DEFAULT 0,
            failed_count INTEGER DEFAULT 0,
            status TEXT DEFAULT 'Completed', -- Pending, In Progress, Completed
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // WhatsApp Message Logs Table
    await run(`
        CREATE TABLE IF NOT EXISTS whatsapp_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id INTEGER,
            phone TEXT NOT NULL,
            message TEXT NOT NULL,
            media_path TEXT DEFAULT '',
            direction TEXT DEFAULT 'OUTGOING', -- OUTGOING, INCOMING
            status TEXT DEFAULT 'SENT', -- QUEUED, SENT, FAILED, RECEIVED
            provider_message_id TEXT DEFAULT '',
            delivery_status TEXT DEFAULT 'SENT', -- QUEUED, SUBMITTED, SENT, DELIVERED, READ, FAILED
            webhook_payload TEXT DEFAULT '',
            error_message TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE SET NULL
        );
    `);

    // WhatsApp Links Table (Click-to-WhatsApp)
    await run(`
        CREATE TABLE IF NOT EXISTS whatsapp_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            phone TEXT NOT NULL,
            normalized_phone TEXT NOT NULL,
            message TEXT DEFAULT '',
            encoded_url TEXT NOT NULL,
            campaign_id INTEGER,
            lead_id INTEGER,
            clicks_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE SET NULL,
            FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE SET NULL
        );
    `);

    // WhatsApp Link Clicks Table
    await run(`
        CREATE TABLE IF NOT EXISTS whatsapp_link_clicks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            link_id INTEGER NOT NULL,
            referrer TEXT DEFAULT '',
            user_agent TEXT DEFAULT '',
            ip_hash TEXT DEFAULT '',
            clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (link_id) REFERENCES whatsapp_links (id) ON DELETE CASCADE
        );
    `);

    // Campaign Recipients Table (Deduplication, Pause/Resume tracking)
    await run(`
        CREATE TABLE IF NOT EXISTS campaign_recipients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id INTEGER NOT NULL,
            lead_id INTEGER,
            phone TEXT NOT NULL,
            status TEXT DEFAULT 'PENDING', -- PENDING, SENT, FAILED, SKIPPED_OPT_OUT, CANCELLED
            provider_message_id TEXT DEFAULT '',
            error_message TEXT DEFAULT '',
            sent_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
            FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE SET NULL,
            UNIQUE(campaign_id, phone)
        );
    `);

    // LeadSquared CRM Outbox Sync Queue
    await run(`
        CREATE TABLE IF NOT EXISTS leadsquared_sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id INTEGER NOT NULL,
            operation TEXT NOT NULL, -- CREATE, UPDATE
            payload TEXT NOT NULL,
            status TEXT DEFAULT 'PENDING', -- PENDING, SYNCED, RETRY_SCHEDULED, FAILED
            attempts INTEGER DEFAULT 0,
            last_error TEXT DEFAULT '',
            next_retry_at DATETIME,
            synced_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE CASCADE
        );
    `);

    // LeadSquared Configuration Table
    await run(`
        CREATE TABLE IF NOT EXISTS leadsquared_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    // Webhook Events Table (Idempotency and Replay Protection)
    await run(`
        CREATE TABLE IF NOT EXISTS webhook_events (
            event_id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // WhatsApp Consent Management Table
    await run(`
        CREATE TABLE IF NOT EXISTS whatsapp_consents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT DEFAULT 'default',
            contact_phone TEXT NOT NULL,
            lead_id INTEGER,
            status TEXT NOT NULL, -- OPTED_IN, OPTED_OUT, PENDING_CONFIRMATION, EXPIRED, REVOKED
            purpose TEXT NOT NULL, -- MARKETING, TRANSACTIONAL, CUSTOMER_SERVICE
            source TEXT NOT NULL, -- WEB_FORM, INBOUND_MESSAGE, PAPER_CONTRACT, PHONE_CALL, API
            collection_method TEXT NOT NULL, -- OPT_IN_FORM, VERBAL_RECORDED, DOCUMENT_SIGNED, KEYWORD_OPT_IN
            consent_evidence TEXT, -- JSON with IP, URL, agreement text, timestamp
            valid_until DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE SET NULL,
            UNIQUE(tenant_id, contact_phone, purpose)
        );
    `);

    // WhatsApp Consent Audit / Revocation History Table
    await run(`
        CREATE TABLE IF NOT EXISTS whatsapp_consent_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT DEFAULT 'default',
            contact_phone TEXT NOT NULL,
            lead_id INTEGER,
            action TEXT NOT NULL, -- GRANTED, REVOKED, UPDATED, EXPIRED
            purpose TEXT NOT NULL,
            previous_status TEXT,
            new_status TEXT NOT NULL,
            source TEXT,
            reason TEXT,
            performed_by TEXT DEFAULT 'SYSTEM',
            evidence TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE SET NULL
        );
    `);

    // WhatsApp Global & Purpose-level Suppressions Table
    await run(`
        CREATE TABLE IF NOT EXISTS whatsapp_suppressions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT DEFAULT 'default',
            contact_phone TEXT NOT NULL,
            reason TEXT NOT NULL, -- KEYWORD_OPT_OUT, MANUAL_SUPPRESSION, SPAM_COMPLAINT, HARD_BOUNCE, LEGAL_REQUEST
            scope TEXT DEFAULT 'GLOBAL', -- GLOBAL, MARKETING, TRANSACTIONAL
            suppressed_by TEXT DEFAULT 'SYSTEM',
            evidence TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(tenant_id, contact_phone, scope)
        );
    `);

    // WhatsApp Compliance Audit Log Table
    await run(`
        CREATE TABLE IF NOT EXISTS compliance_audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT DEFAULT 'default',
            contact_phone TEXT NOT NULL,
            lead_id INTEGER,
            category TEXT NOT NULL, -- MARKETING, TRANSACTIONAL, CUSTOMER_SERVICE
            action TEXT NOT NULL, -- DISPATCH_APPROVED, DISPATCH_BLOCKED, CONSENT_GRANTED, CONSENT_REVOKED, SUPPRESSION_ADDED, SUPPRESSION_REMOVED, OPT_OUT_PROCESSED
            reason TEXT,
            details TEXT,
            actor TEXT DEFAULT 'SYSTEM',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE SET NULL
        );
    `);

    // Compliance Settings Table
    await run(`
        CREATE TABLE IF NOT EXISTS compliance_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT UNIQUE DEFAULT 'default',
            business_name TEXT DEFAULT 'Jai Shree Krishna products and services',
            privacy_policy_url TEXT DEFAULT 'https://example.com/privacy',
            opt_out_keywords TEXT DEFAULT 'STOP,UNSUBSCRIBE,CANCEL,QUIT,END,OPTOUT,ROKO,BAND KARO',
            opt_out_footer_text TEXT DEFAULT 'Reply STOP to unsubscribe.',
            enforce_marketing_consent INTEGER DEFAULT 1,
            enforce_24h_window INTEGER DEFAULT 1,
            default_consent_validity_days INTEGER DEFAULT 365,
            max_retries INTEGER DEFAULT 3,
            initial_retry_delay_ms INTEGER DEFAULT 1000,
            max_retry_delay_ms INTEGER DEFAULT 30000,
            rate_limit_per_second INTEGER DEFAULT 10,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Database Column Migrations (SQLite requires non-expression defaults or null)
    try { await run(`ALTER TABLE templates ADD COLUMN media_path TEXT`); } catch (e) {}
    try { await run(`ALTER TABLE templates ADD COLUMN tenant_id TEXT DEFAULT 'default'`); } catch (e) {}
    try { await run(`ALTER TABLE templates ADD COLUMN external_template_id TEXT DEFAULT ''`); } catch (e) {}
    try { await run(`ALTER TABLE templates ADD COLUMN approval_status TEXT DEFAULT 'APPROVED'`); } catch (e) {}
    try { await run(`ALTER TABLE templates ADD COLUMN language TEXT DEFAULT 'en'`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN media_path TEXT`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN scheduled_at DATETIME`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN updated_at DATETIME`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN error_message TEXT`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN tenant_id TEXT DEFAULT 'default'`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN category TEXT DEFAULT 'MARKETING'`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN custom_message TEXT DEFAULT ''`); } catch (e) {}
    try { await run(`ALTER TABLE whatsapp_logs ADD COLUMN media_path TEXT`); } catch (e) {}
    try { await run(`ALTER TABLE whatsapp_logs ADD COLUMN provider_message_id TEXT`); } catch (e) {}
    try { await run(`ALTER TABLE whatsapp_logs ADD COLUMN delivery_status TEXT`); } catch (e) {}
    try { await run(`ALTER TABLE whatsapp_logs ADD COLUMN webhook_payload TEXT`); } catch (e) {}
    try { await run(`ALTER TABLE whatsapp_logs ADD COLUMN tenant_id TEXT DEFAULT 'default'`); } catch (e) {}
    try { await run(`ALTER TABLE whatsapp_logs ADD COLUMN category TEXT DEFAULT 'MARKETING'`); } catch (e) {}
    try { await run(`ALTER TABLE leads ADD COLUMN opted_out INTEGER DEFAULT 0`); } catch (e) {}
    try { await run(`ALTER TABLE leads ADD COLUMN leadsquared_id TEXT`); } catch (e) {}
    try { await run(`ALTER TABLE leads ADD COLUMN sync_status TEXT DEFAULT 'PENDING'`); } catch (e) {}
    try { await run(`ALTER TABLE leads ADD COLUMN last_synced_at DATETIME`); } catch (e) {}
    try { await run(`ALTER TABLE leads ADD COLUMN tenant_id TEXT DEFAULT 'default'`); } catch (e) {}
    try { await run(`ALTER TABLE leads ADD COLUMN last_inbound_at DATETIME`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN min_delay_seconds INTEGER DEFAULT 60`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN max_delay_seconds INTEGER DEFAULT 120`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN skipped_count INTEGER DEFAULT 0`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN batch_size INTEGER DEFAULT 25`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN batch_delay_minutes INTEGER DEFAULT 10`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN current_batch INTEGER DEFAULT 1`); } catch (e) {}
    try { await run(`ALTER TABLE campaigns ADD COLUMN cooldown_until DATETIME`); } catch (e) {}
    try { await run(`ALTER TABLE whatsapp_consent_history ADD COLUMN actor_role TEXT DEFAULT 'AGENT'`); } catch (e) {}
    try { await run(`ALTER TABLE compliance_audit_logs ADD COLUMN entity_type TEXT DEFAULT 'MESSAGE'`); } catch (e) {}
    try { await run(`ALTER TABLE compliance_audit_logs ADD COLUMN entity_id TEXT`); } catch (e) {}
    try { await run(`ALTER TABLE compliance_audit_logs ADD COLUMN actor_id TEXT`); } catch (e) {}
    try { await run(`ALTER TABLE compliance_audit_logs ADD COLUMN actor_role TEXT DEFAULT 'SYSTEM'`); } catch (e) {}
    try { await run(`ALTER TABLE compliance_audit_logs ADD COLUMN status TEXT DEFAULT 'INFO'`); } catch (e) {}
    try { await run(`ALTER TABLE compliance_audit_logs ADD COLUMN ip_address TEXT`); } catch (e) {}
    try { await run(`ALTER TABLE compliance_settings ADD COLUMN default_provider_type TEXT DEFAULT 'CLOUD_API'`); } catch (e) {}

    // Seed default Compliance Settings if not present
    const compSettingsCount = await get(`SELECT COUNT(*) as count FROM compliance_settings WHERE tenant_id = 'default'`);
    if (compSettingsCount.count === 0) {
        await run(`
            INSERT INTO compliance_settings (tenant_id, business_name, privacy_policy_url, opt_out_keywords, opt_out_footer_text, enforce_marketing_consent, enforce_24h_window)
            VALUES ('default', 'Jai Shree Krishna products and services', 'https://example.com/privacy', 'STOP,UNSUBSCRIBE,CANCEL,QUIT,END,OPTOUT,ROKO,BAND KARO', 'Reply STOP to unsubscribe.', 1, 1)
        `);
    }

    // Seed default LeadSquared config if empty
    const lsqConfig = await get(`SELECT COUNT(*) as count FROM leadsquared_config`);
    if (lsqConfig.count === 0) {
        await run(`
            INSERT INTO leadsquared_config (key, value) VALUES
            ('host', 'https://api-us11.leadsquared.com/v2'),
            ('access_key', 'test_access_key'),
            ('secret_key', 'test_secret_key'),
            ('is_enabled', '0'),
            ('mock_mode', '1')
        `);
    }

    // Seed default sample templates if empty
    const templateCount = await get(`SELECT COUNT(*) as count FROM templates`);
    if (templateCount.count === 0) {
        await run(`
            INSERT INTO templates (name, category, content) VALUES
            ('Welcome Introduction', 'Welcome', 'Hi {{first_name}}! 👋 Thanks for reaching out to us. We received your inquiry regarding {{company}}. How can our team help you today?'),
            ('Quick Follow-up', 'Follow-up', 'Hello {{first_name}}, just following up on our recent conversation. Do you have 5 minutes for a quick chat today? Let me know what time works best for you!'),
            ('Demo / Proposal Invitation', 'Sales', 'Hey {{first_name}}, we have prepared a customized demonstration tailored for {{company}}. Here is our calendar link to pick a convenient slot: https://meet.example.com/demo'),
            ('Exclusive Offer', 'Offer', 'Hello {{first_name}}, we are running a limited-time 20% discount on all our business packages this week. Reply YES to get your coupon code!')
        `);
        console.log('Default templates seeded.');
    }

    // Seed default automation rules if empty
    const autoCount = await get(`SELECT COUNT(*) as count FROM automations`);
    if (autoCount.count === 0) {
        const welcomeTpl = await get(`SELECT id FROM templates WHERE name = 'Welcome Introduction' LIMIT 1`);
        if (welcomeTpl) {
            await run(`
                INSERT INTO automations (name, trigger_type, trigger_condition, action_type, template_id, is_active)
                VALUES ('Auto Welcome on New Lead', 'ON_LEAD_CREATED', '*', 'SEND_WHATSAPP', ?, 1)
            `, [welcomeTpl.id]);
            console.log('Default automation rules seeded.');
        }
    }

    // Seed initial demo leads only if explicitly enabled and not previously initialized/cleared
    const seedConfig = await get(`SELECT value FROM leadsquared_config WHERE key = 'demo_leads_seeded'`);
    if (!seedConfig) {
        await run(`INSERT OR REPLACE INTO leadsquared_config (key, value) VALUES ('demo_leads_seeded', '1')`);
    }
}

module.exports = {
    db,
    run,
    get,
    all,
    initDatabase
};
