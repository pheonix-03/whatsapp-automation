const crypto = require('crypto');
const db = require('./database');
const lsqSync = require('./leadsquared_sync');
const { normalizePhoneNumber } = require('./whatsapp_links');

const STATUS_HIERARCHY = {
    'QUEUED': 1,
    'SUBMITTED': 2,
    'SENT': 3,
    'DELIVERED': 4,
    'READ': 5,
    'FAILED': 6
};

class WhatsAppWebhookHandler {
    constructor() {
        this.verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'leadsquared_wa_token_secure';
        this.appSecret = process.env.WHATSAPP_APP_SECRET || '';
    }

    /**
     * Handles Meta / WhatsApp Cloud API GET verification challenge.
     */
    handleVerification(req, res) {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode === 'subscribe' && token === this.verifyToken) {
            console.log('[Webhook Verification] Webhook verified successfully.');
            return res.status(200).send(challenge);
        } else {
            console.warn('[Webhook Verification Failed] Invalid verify token or mode.');
            return res.status(403).send('Forbidden');
        }
    }

    /**
     * Validates HMAC-SHA256 signature if APP_SECRET is configured.
     */
    validateSignature(req) {
        if (!this.appSecret) return true; // Optional if not set in environment

        const signature = req.headers['x-hub-signature-256'];
        if (!signature) return false;

        const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body);
        const expectedSignature = 'sha256=' + crypto.createHmac('sha256', this.appSecret).update(rawBody).digest('hex');

        try {
            return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
        } catch {
            return false;
        }
    }

    /**
     * Checks if status transition is valid and does not regress.
     */
    canTransitionStatus(currentStatus, newStatus) {
        const currentRank = STATUS_HIERARCHY[currentStatus] || 0;
        const newRank = STATUS_HIERARCHY[newStatus] || 0;

        // FAILED is always an update
        if (newStatus === 'FAILED') return true;

        // Never regress (e.g. from READ back to DELIVERED or SENT)
        return newRank >= currentRank;
    }

    /**
     * Processes inbound WhatsApp webhook payloads idempotently.
     */
    async processWebhook(req, res) {
        if (!this.validateSignature(req)) {
            return res.status(401).json({ error: 'Invalid webhook signature.' });
        }

        const body = req.body;
        if (!body) {
            return res.status(400).json({ error: 'Empty webhook payload.' });
        }

        // 1. OpenWA Self-Hosted Gateway Webhook Format ({ event, data, idempotencyKey, ... })
        if (body.event && body.data) {
            const evt = String(body.event);
            const data = body.data;
            if (evt === 'message.received') {
                const rawFrom = String(data.from || data.chatId || '').replace(/@c\.us|@s\.whatsapp\.net|@lid/g, '');
                await this.processInboundMessage({
                    id: data.id || body.idempotencyKey || `openwa_in_${Date.now()}`,
                    from: rawFrom,
                    body: data.body || data.text || ''
                });
            } else if (evt === 'message.ack' || evt === 'message.sent' || evt === 'message.failed') {
                const msgId = data.messageId || data.id || body.idempotencyKey;
                const statusVal = evt === 'message.failed' ? 'FAILED' : String(data.status || 'SENT').toUpperCase();
                if (msgId) {
                    await this.processStatusUpdate({
                        id: msgId,
                        status: statusVal
                    });
                }
            }
            return res.status(200).json({ status: 'success' });
        }

        // 2. Standard WhatsApp Cloud API / Multi-provider structure
        const entries = body.entry || [body];

        for (const entry of entries) {
            const changes = entry.changes || [entry];

            for (const change of changes) {
                const value = change.value || change;

                // Handle Message Status Updates (sent, delivered, read, failed)
                if (value.statuses && Array.isArray(value.statuses)) {
                    for (const statusObj of value.statuses) {
                        await this.processStatusUpdate(statusObj);
                    }
                }

                // Handle Inbound Messages
                if (value.messages && Array.isArray(value.messages)) {
                    for (const msgObj of value.messages) {
                        await this.processInboundMessage(msgObj);
                    }
                }
            }
        }

        // Always return 200 OK to acknowledge webhook receipt
        return res.status(200).json({ status: 'success' });
    }

    async processStatusUpdate(statusObj) {
        const providerMessageId = statusObj.id;
        const rawStatus = (statusObj.status || '').toUpperCase(); // SENT, DELIVERED, READ, FAILED
        const eventId = `status_${providerMessageId}_${rawStatus}`;

        // Idempotency check: Don't process duplicate webhook events
        const existingEvent = await db.get(`SELECT event_id FROM webhook_events WHERE event_id = ?`, [eventId]);
        if (existingEvent) {
            return;
        }

        // Record event
        await db.run(`
            INSERT INTO webhook_events (event_id, provider, event_type, payload)
            VALUES (?, 'whatsapp', 'status_update', ?)
        `, [eventId, JSON.stringify(statusObj)]);

        // Find corresponding log entry
        const logEntry = await db.get(`
            SELECT * FROM whatsapp_logs 
            WHERE provider_message_id = ? OR id = ?
        `, [providerMessageId, providerMessageId]);

        if (logEntry) {
            if (this.canTransitionStatus(logEntry.delivery_status, rawStatus)) {
                await db.run(`
                    UPDATE whatsapp_logs 
                    SET delivery_status = ?, status = ?, webhook_payload = ? 
                    WHERE id = ?
                `, [rawStatus, rawStatus, JSON.stringify(statusObj), logEntry.id]);

                // Also update campaign recipient status if linked
                await db.run(`
                    UPDATE campaign_recipients 
                    SET status = ? 
                    WHERE provider_message_id = ?
                `, [rawStatus, providerMessageId]);

                console.log(`[Webhook Status] Message ${providerMessageId} transitioned to ${rawStatus}.`);
            } else {
                console.log(`[Webhook Status Ignored] Prevented regression from ${logEntry.delivery_status} to ${rawStatus}.`);
            }
        }
    }

    async processInboundMessage(msgObj) {
        const msgId = msgObj.id;
        const from = msgObj.from;
        const textBody = msgObj.text ? msgObj.text.body : (msgObj.body || '');
        const eventId = `msg_${msgId}`;

        // Idempotency check
        const existingEvent = await db.get(`SELECT event_id FROM webhook_events WHERE event_id = ?`, [eventId]);
        if (existingEvent) return;

        await db.run(`
            INSERT INTO webhook_events (event_id, provider, event_type, payload)
            VALUES (?, 'whatsapp', 'inbound_message', ?)
        `, [eventId, JSON.stringify(msgObj)]);

        const { normalized } = normalizePhoneNumber(from);
        const phoneSuffix = normalized.slice(-10);

        // Find or link lead
        const lead = await db.get(`
            SELECT * FROM leads 
            WHERE phone LIKE '%' || ? OR phone = ? LIMIT 1
        `, [phoneSuffix, normalized]);

        const leadId = lead ? lead.id : null;

        const consentManager = require('./consent_manager');

        // Check for opt-out keywords via ConsentManager
        const optOutResult = await consentManager.handleInboundOptOut({
            tenantId: 'default',
            phone: normalized,
            messageBody: textBody,
            leadId
        });

        if (optOutResult && optOutResult.isOptOut && lead) {
            await db.run(`
                INSERT INTO activities (lead_id, type, title, description)
                VALUES (?, 'OPT_OUT', 'Opt-Out Registered', 'Contact requested unsubscribe via WhatsApp STOP keyword.')
            `, [lead.id]);
        }

        // Update last_inbound_at to open the 24-hour service conversation window
        if (lead) {
            await db.run(`UPDATE leads SET last_inbound_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [lead.id]);
        }

        // Log inbound message
        await db.run(`
            INSERT INTO whatsapp_logs (lead_id, phone, message, direction, status, provider_message_id)
            VALUES (?, ?, ?, 'INCOMING', 'RECEIVED', ?)
        `, [leadId, normalized, textBody, msgId]);

        if (lead) {
            await db.run(`
                INSERT INTO activities (lead_id, type, title, description)
                VALUES (?, 'WHATSAPP_RECEIVED', 'Inbound WhatsApp Message', ?)
            `, [lead.id, textBody]);

            // Sync updated activity to LeadSquared CRM outbox
            lsqSync.enqueueLead(lead.id, 'UPDATE').catch(e => console.error(e));
        }
    }
}

const handler = new WhatsAppWebhookHandler();
module.exports = handler;
