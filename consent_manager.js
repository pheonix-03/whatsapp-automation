const db = require('./database');
const { normalizePhoneNumber } = require('./whatsapp_links');
const complianceService = require('./compliance_service');

const VALID_STATUSES = ['OPTED_IN', 'OPTED_OUT', 'PENDING_CONFIRMATION', 'EXPIRED', 'REVOKED'];
const VALID_PURPOSES = ['MARKETING', 'TRANSACTIONAL', 'CUSTOMER_SERVICE'];
const VALID_COLLECTION_METHODS = ['WEB_FORM', 'INBOUND_MESSAGE', 'CRM_IMPORT', 'API', 'VERBAL', 'PAPER_FORM'];

function extractCleanPhone(input) {
    if (!input) return null;
    if (typeof input === 'object' && input.normalized) return input.normalized;
    const res = normalizePhoneNumber(input);
    if (res && res.isValid && res.normalized) return res.normalized;
    const digits = String(input).replace(/\D/g, '');
    return digits.length >= 8 ? digits : null;
}

class ConsentManager {
    /**
     * Affirmative consent capture workflow.
     * Enforces affirmative user action and rejects inferred/pre-checked consent.
     */
    async captureConsent({
        tenantId = 'default',
        phone,
        leadId = null,
        purpose = 'MARKETING',
        status = 'OPTED_IN',
        source = 'WEB_FORM',
        collectionMethod = 'WEB_FORM',
        consentEvidence = null,
        validUntil = null,
        actorId = null,
        actorRole = 'AGENT',
        reason = 'Explicit affirmative opt-in captured'
    }) {
        const cleanPhone = extractCleanPhone(phone);
        if (!cleanPhone) {
            throw new Error(`Invalid phone number: '${phone}'`);
        }

        if (!VALID_PURPOSES.includes(purpose)) {
            throw new Error(`Invalid communication purpose: '${purpose}'. Allowed: ${VALID_PURPOSES.join(', ')}`);
        }

        if (!VALID_STATUSES.includes(status)) {
            throw new Error(`Invalid consent status: '${status}'. Allowed: ${VALID_STATUSES.join(', ')}`);
        }

        // Compliance Guard: Affirmative consent requirement.
        // Inferred consent (e.g. empty evidence during CRM import) is strictly forbidden for OPTED_IN.
        if (status === 'OPTED_IN' && (!consentEvidence || String(consentEvidence).trim() === '')) {
            throw new Error('Affirmative consent requires verifiable evidence (e.g., form submission ID, IP timestamp, or opt-in signature). Inferred consent is prohibited.');
        }

        // Get existing consent record to record previous status
        const existing = await db.get(`
            SELECT * FROM whatsapp_consents 
            WHERE tenant_id = ? AND contact_phone = ? AND purpose = ?
        `, [tenantId, cleanPhone, purpose]);

        const prevStatus = existing ? existing.status : 'NONE';

        // Upsert into whatsapp_consents
        if (existing) {
            await db.run(`
                UPDATE whatsapp_consents 
                SET lead_id = ?, status = ?, source = ?, collection_method = ?, consent_evidence = ?, valid_until = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [leadId || existing.lead_id, status, source, collectionMethod, consentEvidence, validUntil, existing.id]);
        } else {
            await db.run(`
                INSERT INTO whatsapp_consents 
                (tenant_id, contact_phone, lead_id, status, purpose, source, collection_method, consent_evidence, valid_until)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [tenantId, cleanPhone, leadId, status, purpose, source, collectionMethod, consentEvidence, validUntil]);
        }

        // Record in whatsapp_consent_history
        await db.run(`
            INSERT INTO whatsapp_consent_history 
            (tenant_id, contact_phone, lead_id, action, purpose, previous_status, new_status, reason, performed_by, actor_role, evidence)
            VALUES (?, ?, ?, 'CAPTURE', ?, ?, ?, ?, ?, ?, ?)
        `, [tenantId, cleanPhone, leadId, purpose, prevStatus, status, reason, actorId || actorRole, actorRole, consentEvidence]);

        // Audit log
        await complianceService.logAudit({
            tenantId,
            action: 'CONSENT_CAPTURED',
            entityType: 'CONSENT',
            entityId: cleanPhone,
            actorId,
            actorRole,
            status: 'SUCCESS',
            details: { phone: cleanPhone, purpose, status, prevStatus, source, collectionMethod }
        });

        // If status is OPTED_IN, remove any marketing suppression for this phone
        if (status === 'OPTED_IN') {
            await db.run(`
                DELETE FROM whatsapp_suppressions 
                WHERE tenant_id = ? AND contact_phone = ? AND (scope = 'MARKETING' OR scope = ?)
            `, [tenantId, cleanPhone, purpose]);
        }

        return this.getConsentRecord(tenantId, cleanPhone, purpose);
    }

    /**
     * Revoke WhatsApp consent for specific purpose or all purposes
     */
    async revokeConsent({
        tenantId = 'default',
        phone,
        purpose = 'MARKETING',
        reason = 'User requested revocation',
        actorId = null,
        actorRole = 'AGENT'
    }) {
        const cleanPhone = extractCleanPhone(phone);
        if (!cleanPhone) {
            throw new Error(`Invalid phone number: '${phone}'`);
        }

        const existing = await db.get(`
            SELECT * FROM whatsapp_consents 
            WHERE tenant_id = ? AND contact_phone = ? AND purpose = ?
        `, [tenantId, cleanPhone, purpose]);

        const prevStatus = existing ? existing.status : 'NONE';

        if (existing) {
            await db.run(`
                UPDATE whatsapp_consents 
                SET status = 'REVOKED', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [existing.id]);
        } else {
            await db.run(`
                INSERT INTO whatsapp_consents 
                (tenant_id, contact_phone, status, purpose, source, collection_method, consent_evidence)
                VALUES (?, ?, 'REVOKED', ?, 'SYSTEM', 'API', 'Revocation recorded')
            `, [tenantId, cleanPhone, purpose]);
        }

        // Record in history
        await db.run(`
            INSERT INTO whatsapp_consent_history 
            (tenant_id, contact_phone, lead_id, action, purpose, previous_status, new_status, reason, performed_by, actor_role, evidence)
            VALUES (?, ?, ?, 'REVOKE', ?, ?, 'REVOKED', ?, ?, ?, 'Revocation request')
        `, [tenantId, cleanPhone, existing ? existing.lead_id : null, purpose, prevStatus, reason, actorId || actorRole, actorRole]);

        // Audit log
        await complianceService.logAudit({
            tenantId,
            action: 'CONSENT_REVOKED',
            entityType: 'CONSENT',
            entityId: cleanPhone,
            actorId,
            actorRole,
            status: 'SUCCESS',
            details: { phone: cleanPhone, purpose, prevStatus, reason }
        });

        // Cancel any pending marketing messages immediately
        if (purpose === 'MARKETING') {
            await this.cancelQueuedMessagesForContact(tenantId, cleanPhone, 'Consent revoked by user');
        }

        return { success: true, phone: cleanPhone, purpose, status: 'REVOKED' };
    }

    /**
     * Get consent record for a phone and purpose
     */
    async getConsentRecord(tenantId = 'default', phone, purpose = 'MARKETING') {
        const cleanPhone = extractCleanPhone(phone) || phone;
        return db.get(`
            SELECT * FROM whatsapp_consents 
            WHERE tenant_id = ? AND contact_phone = ? AND purpose = ?
        `, [tenantId, cleanPhone, purpose]);
    }

    /**
     * Get all consent records for a phone
     */
    async getAllConsentsForPhone(tenantId = 'default', phone) {
        const cleanPhone = extractCleanPhone(phone) || phone;
        return db.all(`
            SELECT * FROM whatsapp_consents 
            WHERE tenant_id = ? AND contact_phone = ?
            ORDER BY purpose ASC
        `, [tenantId, cleanPhone]);
    }

    /**
     * Get consent audit history for a contact
     */
    async getConsentHistory(tenantId = 'default', phone) {
        const cleanPhone = extractCleanPhone(phone) || phone;
        return db.all(`
            SELECT * FROM whatsapp_consent_history 
            WHERE tenant_id = ? AND contact_phone = ?
            ORDER BY id DESC
        `, [tenantId, cleanPhone]);
    }

    /**
     * Add contact to global or scoped suppression list.
     * Enforces RBAC: Only ADMIN or COMPLIANCE_OFFICER can alter suppression records.
     */
    async addSuppression({
        tenantId = 'default',
        phone,
        reason = 'USER_OPT_OUT',
        scope = 'GLOBAL',
        actorId = null,
        actorRole = 'ADMIN',
        evidence = 'Direct opt-out request'
    }) {
        if (actorRole !== 'ADMIN' && actorRole !== 'COMPLIANCE_OFFICER' && actorRole !== 'SYSTEM') {
            throw new Error(`Unauthorized: Role '${actorRole}' is not permitted to alter suppression records.`);
        }

        const cleanPhone = extractCleanPhone(phone);
        if (!cleanPhone) {
            throw new Error(`Invalid phone number: '${phone}'`);
        }

        // Insert or replace into whatsapp_suppressions
        await db.run(`
            INSERT INTO whatsapp_suppressions 
            (tenant_id, contact_phone, reason, scope, suppressed_by, evidence)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, contact_phone, scope) 
            DO UPDATE SET reason = excluded.reason, evidence = excluded.evidence, suppressed_by = excluded.suppressed_by, created_at = CURRENT_TIMESTAMP
        `, [tenantId, cleanPhone, reason, scope, actorId || actorRole, evidence]);

        // Revoke marketing consent
        await this.revokeConsent({
            tenantId,
            phone: cleanPhone,
            purpose: 'MARKETING',
            reason: `Suppressed: ${reason}`,
            actorId,
            actorRole
        });

        // Also mark lead opted_out = 1 if present
        await db.run(`
            UPDATE leads SET opted_out = 1, updated_at = CURRENT_TIMESTAMP 
            WHERE phone LIKE ? OR phone LIKE ?
        `, [`%${cleanPhone.slice(-10)}`, cleanPhone]);

        // Audit log
        await complianceService.logAudit({
            tenantId,
            action: 'SUPPRESSION_ADDED',
            entityType: 'SUPPRESSION',
            entityId: cleanPhone,
            actorId,
            actorRole,
            status: 'SUCCESS',
            details: { phone: cleanPhone, reason, scope, evidence }
        });

        // Crucial requirement: Immediately cancel queued marketing messages for this phone!
        const cancelledCount = await this.cancelQueuedMessagesForContact(tenantId, cleanPhone, `Suppressed: ${reason}`);

        return {
            success: true,
            phone: cleanPhone,
            scope,
            reason,
            cancelledQueuedMessages: cancelledCount
        };
    }

    /**
     * Remove contact from suppression list (RBAC protected)
     */
    async removeSuppression({
        tenantId = 'default',
        phone,
        scope = 'GLOBAL',
        actorId = null,
        actorRole = 'ADMIN'
    }) {
        if (actorRole !== 'ADMIN' && actorRole !== 'COMPLIANCE_OFFICER') {
            throw new Error(`Unauthorized: Role '${actorRole}' is not permitted to remove suppression records.`);
        }

        const cleanPhone = extractCleanPhone(phone);
        if (!cleanPhone) {
            throw new Error(`Invalid phone number: '${phone}'`);
        }

        const result = await db.run(`
            DELETE FROM whatsapp_suppressions 
            WHERE tenant_id = ? AND contact_phone = ? AND scope = ?
        `, [tenantId, cleanPhone, scope]);

        await complianceService.logAudit({
            tenantId,
            action: 'SUPPRESSION_REMOVED',
            entityType: 'SUPPRESSION',
            entityId: cleanPhone,
            actorId,
            actorRole,
            status: 'SUCCESS',
            details: { phone: cleanPhone, scope, changes: result.changes }
        });

        return { success: true, removedCount: result.changes };
    }

    /**
     * List suppressions with search & pagination
     */
    async listSuppressions({
        tenantId = 'default',
        page = 1,
        limit = 50,
        search = ''
    }) {
        const offset = (Math.max(1, page) - 1) * limit;
        let whereSql = 'tenant_id = ?';
        let params = [tenantId];

        if (search && search.trim() !== '') {
            whereSql += ' AND (contact_phone LIKE ? OR reason LIKE ? OR suppressed_by LIKE ?)';
            const s = `%${search.trim()}%`;
            params.push(s, s, s);
        }

        const countRow = await db.get(`SELECT COUNT(*) as total FROM whatsapp_suppressions WHERE ${whereSql}`, params);
        const rows = await db.all(`
            SELECT * FROM whatsapp_suppressions 
            WHERE ${whereSql}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        return {
            total: countRow ? countRow.total : 0,
            page,
            limit,
            suppressions: rows
        };
    }

    /**
     * Immediate cancellation of all queued marketing messages across
     * in-memory queue and SQLite campaign_recipients for a specific contact.
     */
    async cancelQueuedMessagesForContact(tenantId = 'default', phone, cancellationReason = 'Opted out') {
        const cleanPhone = extractCleanPhone(phone) || phone;
        let totalCancelled = 0;

        // 1. Cancel in database campaign_recipients
        const result = await db.run(`
            UPDATE campaign_recipients 
            SET status = 'CANCELLED_OPT_OUT', error_message = ?
            WHERE phone LIKE ? AND status = 'PENDING'
        `, [cancellationReason, `%${cleanPhone.slice(-10)}`]);

        totalCancelled += (result ? result.changes : 0);

        // 2. Also cancel in whatsapp in-memory queue if loaded
        try {
            const whatsapp = require('./whatsapp');
            if (whatsapp && Array.isArray(whatsapp.queue)) {
                const initialLen = whatsapp.queue.length;
                whatsapp.queue = whatsapp.queue.filter(task => {
                    const match = task.cleanPhone === cleanPhone || 
                                  (task.cleanPhone && task.cleanPhone.endsWith(cleanPhone.slice(-10)));
                    if (match) {
                        task.reject(new Error(`Message cancelled before dispatch: ${cancellationReason}`));
                        return false; // remove from queue
                    }
                    return true;
                });
                totalCancelled += (initialLen - whatsapp.queue.length);
            }
        } catch (e) {}

        return totalCancelled;
    }

    /**
     * Process inbound message text for opt-out keywords.
     * Supports: STOP, UNSUBSCRIBE, CANCEL, QUIT, END, OPTOUT, ROKO, BAND KARO and configurable phrases.
     */
    async handleInboundOptOut({
        tenantId = 'default',
        phone,
        messageBody = '',
        leadId = null,
        rawPayload = null
    }) {
        if (!messageBody || typeof messageBody !== 'string') {
            return { isOptOut: false };
        }

        const settings = await complianceService.getTenantSettings(tenantId);
        const text = messageBody.trim().toUpperCase();

        // Check exact match or leading word match
        const isOptOutMatch = settings.optOutKeywordsList.some(kw => {
            return text === kw || text.startsWith(`${kw} `) || text.startsWith(`${kw}.`);
        });

        if (!isOptOutMatch) {
            return { isOptOut: false };
        }

        console.log(`[WhatsApp Compliance Opt-Out] Contact ${phone} triggered opt-out with message: "${messageBody}"`);

        // Add suppression
        const suppressionResult = await this.addSuppression({
            tenantId,
            phone,
            reason: 'INBOUND_KEYWORD',
            scope: 'GLOBAL',
            actorRole: 'SYSTEM',
            evidence: `Inbound message keyword match: "${messageBody.substring(0, 100)}"`
        });

        return {
            isOptOut: true,
            phone,
            suppressionResult,
            matchedKeyword: text
        };
    }
}

const consentManager = new ConsentManager();
module.exports = consentManager;
