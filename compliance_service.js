const db = require('./database');
const { normalizePhoneNumber } = require('./whatsapp_links');

function extractCleanPhone(input) {
    if (!input) return null;
    if (typeof input === 'object' && input.normalized) return input.normalized;
    const res = normalizePhoneNumber(input);
    if (res && res.isValid && res.normalized) return res.normalized;
    const digits = String(input).replace(/\D/g, '');
    return digits.length >= 8 ? digits : null;
}

class ComplianceService {
    constructor() {
        this.cacheSettings = new Map();
    }

    /**
     * Retrieve tenant compliance settings or default fallback
     */
    async getTenantSettings(tenantId = 'default') {
        let row = await db.get(`SELECT * FROM compliance_settings WHERE tenant_id = ?`, [tenantId]);
        if (!row) {
            // Seed default settings for tenant
            await db.run(`
                INSERT OR IGNORE INTO compliance_settings 
                (tenant_id, business_name, opt_out_keywords, opt_out_footer_text, enforce_24h_window, default_provider_type)
                VALUES (?, 'Jai Shree Krishna products and services', 'STOP,UNSUBSCRIBE,CANCEL,QUIT,END,OPTOUT,ROKO,BAND KARO', 'Reply STOP to unsubscribe.', 1, 'CLOUD_API')
            `, [tenantId]);
            row = await db.get(`SELECT * FROM compliance_settings WHERE tenant_id = ?`, [tenantId]);
        }

        const keywords = (row.opt_out_keywords || 'STOP,UNSUBSCRIBE')
            .split(',')
            .map(k => k.trim().toUpperCase())
            .filter(Boolean);

        return {
            ...row,
            optOutKeywordsList: keywords
        };
    }

    /**
     * Update tenant compliance settings with RBAC check
     */
    async updateTenantSettings(tenantId = 'default', updates = {}, actorRole = 'ADMIN') {
        if (actorRole !== 'ADMIN' && actorRole !== 'COMPLIANCE_OFFICER') {
            throw new Error(`Unauthorized: Role '${actorRole}' cannot modify compliance settings.`);
        }

        const current = await this.getTenantSettings(tenantId);
        const businessName = updates.business_name !== undefined ? updates.business_name : current.business_name;
        const optOutKeywords = updates.opt_out_keywords !== undefined ? updates.opt_out_keywords : current.opt_out_keywords;
        const optOutFooter = updates.opt_out_footer_text !== undefined ? updates.opt_out_footer_text : current.opt_out_footer_text;
        const enforceConsent = updates.enforce_marketing_consent !== undefined ? (updates.enforce_marketing_consent ? 1 : 0) : (current.enforce_marketing_consent !== undefined ? current.enforce_marketing_consent : 1);
        const enforce24h = updates.enforce_24h_window !== undefined ? (updates.enforce_24h_window ? 1 : 0) : current.enforce_24h_window;
        const defaultProvider = updates.default_provider_type !== undefined ? updates.default_provider_type : current.default_provider_type;

        await db.run(`
            UPDATE compliance_settings 
            SET business_name = ?, opt_out_keywords = ?, opt_out_footer_text = ?, enforce_marketing_consent = ?, enforce_24h_window = ?, default_provider_type = ?, updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = ?
        `, [businessName, optOutKeywords, optOutFooter, enforceConsent, enforce24h, defaultProvider, tenantId]);

        await this.logAudit({
            tenantId,
            action: 'UPDATE_SETTINGS',
            entityType: 'SETTINGS',
            entityId: tenantId,
            actorRole,
            status: 'SUCCESS',
            details: { updates }
        });

        return this.getTenantSettings(tenantId);
    }

    /**
     * Automatically append mandatory compliance opt-out footer to outbound messages if missing
     */
    applyComplianceFormatting(text = '', category = 'MARKETING', settings = {}) {
        if (!text || typeof text !== 'string' || text.trim() === '') return text || '';
        let formatted = text.trim();
        const cat = String(category || 'MARKETING').toUpperCase();
        if (cat === 'MARKETING' || cat === 'OFFER' || cat === 'BROADCAST') {
            const footer = (settings.opt_out_footer_text || 'Reply STOP to unsubscribe.').trim();
            if (footer) {
                const upperText = formatted.toUpperCase();
                const upperFooter = footer.toUpperCase();
                if (!upperText.includes('STOP') && !upperText.includes('UNSUBSCRIBE') && !upperText.includes(upperFooter)) {
                    formatted = `${formatted}\n\n${footer}`;
                }
            }
        }
        return formatted;
    }

    /**
     * Validate template placeholders, missing variables, opt-out footer & links
     */
    validateTemplateContent(text = '', category = 'MARKETING', settings = {}) {
        const errors = [];
        const warnings = [];

        if (!text || text.trim() === '') {
            errors.push('Message or template content cannot be empty.');
            return { valid: false, errors, warnings };
        }

        // 1. Detect unresolved template placeholders like {{1}}, {{name}}, {{invalid}}
        const placeholderRegex = /\{\{([a-zA-Z0-9_]+)\}\}/g;
        const matches = text.match(placeholderRegex) || [];
        const allowedLeadFields = ['{{first_name}}', '{{last_name}}', '{{company}}', '{{phone}}', '{{stage}}'];

        const unresolvedPlaceholders = [];
        for (const m of matches) {
            // Numbers {{1}}, {{2}} or variables not in standard lead fields
            if (!allowedLeadFields.includes(m)) {
                unresolvedPlaceholders.push(m);
            }
        }
        if (unresolvedPlaceholders.length > 0) {
            errors.push(`Unresolved or unsupported placeholder variables detected: ${unresolvedPlaceholders.join(', ')}`);
        }

        // 2. Validate links
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = text.match(urlRegex) || [];
        for (const u of urls) {
            if (u.includes('bit.ly') || u.includes('tinyurl.com') || u.includes('t.co')) {
                warnings.push(`Shortened link detected (${u}). Major WhatsApp filters flag generic shorteners as spam. Use branded domains.`);
            }
        }

        // 3. For MARKETING category: mandatory opt-out notice
        if (category === 'MARKETING') {
            const footerText = (settings.opt_out_footer_text || 'STOP').toUpperCase();
            const upperText = text.toUpperCase();
            if (!upperText.includes('STOP') && !upperText.includes('UNSUBSCRIBE') && !upperText.includes(footerText)) {
                warnings.push('Marketing message lacks mandatory opt-out instructions (e.g. "Reply STOP to unsubscribe").');
            }

            const businessName = (settings.business_name || '').trim().toUpperCase();
            if (businessName && !upperText.includes(businessName)) {
                warnings.push(`Marketing message does not explicitly mention business identity ("${settings.business_name}"). Clear sender identity is required by WhatsApp Business Policy.`);
            }
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings,
            disclaimer: 'Note: Local heuristic validation checks formatting compliance, but does not guarantee Meta template approval.'
        };
    }

    /**
     * Check if contact is within 24-hour customer care window
     */
    async check24HourWindow(tenantId = 'default', phone = '', leadId = null) {
        let lastInboundAt = null;

        // 1. Check leads table
        if (leadId) {
            const lead = await db.get(`SELECT last_inbound_at FROM leads WHERE id = ?`, [leadId]);
            if (lead && lead.last_inbound_at) {
                lastInboundAt = lead.last_inbound_at;
            }
        }

        // 2. Fallback check whatsapp_logs for INCOMING
        if (!lastInboundAt && phone) {
            const clean = normalizePhoneNumber(phone) || phone;
            const log = await db.get(`
                SELECT created_at FROM whatsapp_logs 
                WHERE phone = ? AND direction = 'INCOMING' 
                ORDER BY id DESC LIMIT 1
            `, [clean]);
            if (log && log.created_at) {
                lastInboundAt = log.created_at;
            }
        }

        if (!lastInboundAt) {
            return { withinWindow: false, lastInboundAt: null, hoursElapsed: Infinity };
        }

        const inboundTime = new Date(lastInboundAt).getTime();
        const now = Date.now();
        const diffMs = now - inboundTime;
        const hoursElapsed = diffMs / (1000 * 60 * 60);

        return {
            withinWindow: hoursElapsed <= 24,
            lastInboundAt,
            hoursElapsed: Math.round(hoursElapsed * 10) / 10
        };
    }

    /**
     * Check suppression status for phone
     */
    async checkSuppression(tenantId = 'default', phone = '', scope = 'GLOBAL') {
        const clean = extractCleanPhone(phone);
        if (!clean) return { suppressed: false, record: null };
        const row = await db.get(`
            SELECT * FROM whatsapp_suppressions 
            WHERE tenant_id = ? AND contact_phone = ? AND (scope = 'GLOBAL' OR scope = ?)
        `, [tenantId, clean, scope]);

        if (row) {
            return { suppressed: true, record: row };
        }
        return { suppressed: false, record: null };
    }

    /**
     * Check consent status for phone and purpose
     */
    async checkConsent(tenantId = 'default', phone = '', purpose = 'MARKETING') {
        const clean = extractCleanPhone(phone);
        if (!clean) {
            return { valid: false, status: 'INVALID_PHONE', record: null, reason: 'Invalid phone number.' };
        }
        const row = await db.get(`
            SELECT * FROM whatsapp_consents 
            WHERE tenant_id = ? AND contact_phone = ? AND purpose = ?
        `, [tenantId, clean, purpose]);

        if (!row) {
            return { valid: false, status: 'MISSING', record: null, reason: `No consent record found for purpose '${purpose}'.` };
        }

        if (row.status !== 'OPTED_IN') {
            return { valid: false, status: row.status, record: row, reason: `Consent status is '${row.status}'.` };
        }

        if (row.valid_until) {
            const expiryTime = new Date(row.valid_until).getTime();
            if (expiryTime < Date.now()) {
                return { valid: false, status: 'EXPIRED', record: row, reason: `Consent expired on ${row.valid_until}.` };
            }
        }

        return { valid: true, status: 'OPTED_IN', record: row, reason: 'Valid active consent confirmed.' };
    }

    /**
     * Centralized pre-dispatch validation engine.
     * All outbound WhatsApp messages must pass this check.
     */
    async validateOutboundMessage({
        tenantId = 'default',
        to,
        leadId = null,
        category = 'MARKETING',
        templateId = null,
        messageBody = '',
        providerType = 'CLOUD_API',
        userRole = 'AGENT'
    }) {
        const cleanPhone = extractCleanPhone(to);
        const settings = await this.getTenantSettings(tenantId);

        // 1. Phone validity
        if (!cleanPhone) {
            await this.logAudit({
                tenantId,
                action: 'DISPATCH_BLOCKED',
                entityType: 'MESSAGE',
                status: 'BLOCKED',
                details: { to, reason: 'INVALID_PHONE', message: 'Invalid or incomplete phone number.' }
            });
            return {
                allowed: false,
                reason: 'INVALID_PHONE',
                message: 'Invalid or incomplete phone number provided.'
            };
        }

        // 2. Suppression Check
        const suppression = await this.checkSuppression(tenantId, cleanPhone, category);
        if (suppression.suppressed) {
            await this.logAudit({
                tenantId,
                action: 'DISPATCH_BLOCKED',
                entityType: 'MESSAGE',
                status: 'BLOCKED',
                details: { to: cleanPhone, reason: 'SUPPRESSED', suppressionReason: suppression.record.reason }
            });
            return {
                allowed: false,
                reason: 'SUPPRESSED',
                message: `Contact ${cleanPhone} is on tenant suppression list (Reason: ${suppression.record.reason}).`
            };
        }

        // 3. Consent Check
        const consent = await this.checkConsent(tenantId, cleanPhone, category);
        if (!consent.valid) {
            if (settings.enforce_marketing_consent !== 0 || consent.status === 'REVOKED' || consent.status === 'OPTED_OUT') {
                await this.logAudit({
                    tenantId,
                    action: 'DISPATCH_BLOCKED',
                    entityType: 'MESSAGE',
                    status: 'BLOCKED',
                    details: { to: cleanPhone, reason: 'NO_CONSENT', consentStatus: consent.status, detail: consent.reason }
                });
                return {
                    allowed: false,
                    reason: 'NO_CONSENT',
                    message: `Outbound send blocked: Missing or invalid consent for purpose '${category}' (${consent.reason}).`
                };
            }
        }

        // 4. 24-Hour Messaging Window & Provider Policy Check
        const windowCheck = await this.check24HourWindow(tenantId, cleanPhone, leadId);
        
        // Meta Cloud API Rules:
        // Freeform session messages are ONLY allowed within 24h of customer inbound.
        // Outside 24h, Meta requires pre-approved HSM templates.
        if (providerType === 'CLOUD_API' && settings.enforce_24h_window) {
            if (!windowCheck.withinWindow && !templateId) {
                await this.logAudit({
                    tenantId,
                    action: 'DISPATCH_BLOCKED',
                    entityType: 'MESSAGE',
                    status: 'BLOCKED',
                    details: { 
                        to: cleanPhone, 
                        reason: 'WINDOW_EXPIRED', 
                        provider: 'CLOUD_API',
                        hoursElapsed: windowCheck.hoursElapsed,
                        message: 'Meta Cloud API requires approved template message outside 24h conversation window.' 
                    }
                });
                return {
                    allowed: false,
                    reason: 'WINDOW_EXPIRED',
                    message: 'Meta Cloud API 24-hour service window expired. Freeform messages are prohibited; an approved HSM template is required.'
                };
            }
        }

        // 5. Template & Content Validation Check
        const contentValidation = this.validateTemplateContent(messageBody, category, settings);
        if (!contentValidation.valid) {
            await this.logAudit({
                tenantId,
                action: 'DISPATCH_BLOCKED',
                entityType: 'MESSAGE',
                status: 'BLOCKED',
                details: { to: cleanPhone, reason: 'TEMPLATE_INVALID', errors: contentValidation.errors }
            });
            return {
                allowed: false,
                reason: 'TEMPLATE_INVALID',
                message: `Content validation failed: ${contentValidation.errors.join('; ')}`
            };
        }

        // Send Approved!
        await this.logAudit({
            tenantId,
            action: 'DISPATCH_APPROVED',
            entityType: 'MESSAGE',
            status: 'APPROVED',
            details: {
                to: cleanPhone,
                category,
                providerType,
                within24hWindow: windowCheck.withinWindow,
                warnings: contentValidation.warnings
            }
        });

        return {
            allowed: true,
            reason: 'APPROVED',
            message: 'Message passed all compliance, consent, and suppression checks.',
            warnings: contentValidation.warnings,
            within24hWindow: windowCheck.withinWindow
        };
    }

    /**
     * Audit logger for all compliance decisions & actions
     */
    async logAudit({
        tenantId = 'default',
        action,
        entityType = 'MESSAGE',
        entityId = null,
        actorId = null,
        actorRole = 'SYSTEM',
        status = 'INFO',
        details = {},
        ipAddress = null
    }) {
        try {
            const contactPhone = (details && details.to) || (details && details.phone) || (entityType === 'CONSENT' || entityType === 'SUPPRESSION' || entityType === 'MESSAGE' ? String(entityId || '') : 'SYSTEM');
            const category = (details && details.category) || 'MARKETING';
            await db.run(`
                INSERT INTO compliance_audit_logs 
                (tenant_id, contact_phone, category, action, entity_type, entity_id, actor_id, actor_role, status, details, ip_address)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                tenantId,
                contactPhone,
                category,
                action,
                entityType,
                entityId ? String(entityId) : null,
                actorId ? String(actorId) : null,
                actorRole,
                status,
                typeof details === 'object' ? JSON.stringify(details) : String(details),
                ipAddress
            ]);
        } catch (err) {
            console.error('[Compliance Audit Log Error]', err.message);
        }
    }

    /**
     * Query audit logs with pagination & filtering
     */
    async getAuditLogs({
        tenantId = 'default',
        page = 1,
        limit = 50,
        action = null,
        status = null,
        search = null,
        startDate = null,
        endDate = null
    }) {
        const offset = (Math.max(1, page) - 1) * limit;
        let whereClauses = ['tenant_id = ?'];
        let params = [tenantId];

        if (action) {
            whereClauses.push('action = ?');
            params.push(action);
        }
        if (status) {
            whereClauses.push('status = ?');
            params.push(status);
        }
        if (search) {
            whereClauses.push('(entity_id LIKE ? OR details LIKE ? OR actor_role LIKE ?)');
            const s = `%${search}%`;
            params.push(s, s, s);
        }
        if (startDate) {
            whereClauses.push('created_at >= ?');
            params.push(startDate);
        }
        if (endDate) {
            whereClauses.push('created_at <= ?');
            params.push(endDate);
        }

        const whereSql = whereClauses.join(' AND ');

        const countRow = await db.get(`
            SELECT COUNT(*) as total FROM compliance_audit_logs WHERE ${whereSql}
        `, params);

        const logs = await db.all(`
            SELECT * FROM compliance_audit_logs 
            WHERE ${whereSql}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        return {
            total: countRow ? countRow.total : 0,
            page,
            limit,
            logs: logs.map(l => ({
                ...l,
                details: l.details ? JSON.parse(l.details) : {}
            }))
        };
    }

    /**
     * Export audit logs to CSV format
     */
    async exportAuditLogsCsv(tenantId = 'default') {
        const logs = await db.all(`
            SELECT id, tenant_id, action, entity_type, entity_id, actor_id, actor_role, status, details, ip_address, created_at 
            FROM compliance_audit_logs 
            WHERE tenant_id = ? 
            ORDER BY id DESC 
            LIMIT 5000
        `, [tenantId]);

        const header = ['ID', 'Timestamp', 'Tenant', 'Action', 'Entity Type', 'Entity ID', 'Actor Role', 'Status', 'Details', 'IP Address'];
        const rows = [header.join(',')];

        for (const l of logs) {
            const escapedDetails = (l.details || '').replace(/"/g, '""');
            rows.push([
                l.id,
                `"${l.created_at}"`,
                `"${l.tenant_id}"`,
                `"${l.action}"`,
                `"${l.entity_type}"`,
                `"${l.entity_id || ''}"`,
                `"${l.actor_role}"`,
                `"${l.status}"`,
                `"${escapedDetails}"`,
                `"${l.ip_address || ''}"`
            ].join(','));
        }

        return rows.join('\n');
    }
}

const service = new ComplianceService();
module.exports = service;
