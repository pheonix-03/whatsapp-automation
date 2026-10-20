const db = require('./database');
const whatsapp = require('./whatsapp');
const { normalizePhoneNumber } = require('./whatsapp_links');
const complianceService = require('./compliance_service');

const VALID_CAMPAIGN_STATES = [
    'Draft',
    'Scheduled',
    'Queued',
    'Running',
    'Paused',
    'Completed',
    'Failed',
    'Cancelled'
];

const VALID_TRANSITIONS = {
    'Draft': ['Scheduled', 'Queued', 'Running', 'Cancelled'],
    'Scheduled': ['Running', 'Cancelled'],
    'Queued': ['Running', 'Cancelled'],
    'Running': ['Paused', 'Completed', 'Failed', 'Cancelled'],
    'Paused': ['Running', 'Cancelled'],
    'Completed': [],
    'Failed': [],
    'Cancelled': []
};

class CampaignManager {
    constructor() {
        this.activeDispatchers = new Map(); // campaignId -> boolean (is cancelled/paused)
        this.skipCooldownSignals = new Map(); // campaignId -> boolean (skip cooldown signal)
        this.schedulerInterval = null;
    }

    initScheduler() {
        if (process.env.NODE_ENV === 'test' || process.argv.some(a => a.includes('test'))) return;
        if (this.schedulerInterval) return;
        this.schedulerInterval = setInterval(() => {
            this.checkScheduledCampaigns().catch(err => {
                console.error('[Campaign Scheduler Error]', err.message);
            });
        }, 15000); // Check every 15s
        if (this.schedulerInterval && this.schedulerInterval.unref) {
            this.schedulerInterval.unref();
        }
    }

    stopScheduler() {
        if (this.schedulerInterval) {
            clearInterval(this.schedulerInterval);
            this.schedulerInterval = null;
        }
    }

    async checkScheduledCampaigns() {
        const now = new Date().toISOString();
        const due = await db.all(`
            SELECT id FROM campaigns 
            WHERE status = 'Scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
        `, [now]);

        for (const c of due) {
            console.log(`[Campaign Scheduler] Starting scheduled campaign #${c.id}...`);
            await this.startCampaign(c.id).catch(e => console.error(e));
        }

        // Auto-resume running campaigns if server rebooted (only if they have pending recipients)
        const running = await db.all(`
            SELECT c.id FROM campaigns c
            JOIN campaign_recipients cr ON c.id = cr.campaign_id
            WHERE c.status = 'Running' AND cr.status = 'PENDING'
            GROUP BY c.id
        `);
        for (const c of running) {
            if (!this.activeDispatchers.has(c.id)) {
                console.log(`[Campaign Scheduler] Resuming running campaign #${c.id}...`);
                this.activeDispatchers.set(c.id, true);
                this.dispatchCampaignRecipients(c.id).catch(e => console.error(e));
            }
        }
    }

    validateStateTransition(currentStatus, nextStatus) {
        if (!VALID_CAMPAIGN_STATES.includes(nextStatus)) {
            throw new Error(`Invalid campaign status: '${nextStatus}'`);
        }
        const allowed = VALID_TRANSITIONS[currentStatus] || [];
        if (!allowed.includes(nextStatus)) {
            throw new Error(`Cannot transition campaign from '${currentStatus}' to '${nextStatus}'.`);
        }
        return true;
    }

    async preflightCampaign({
        targetStage = 'ALL',
        templateId = null,
        customMessage = '',
        category = 'MARKETING',
        tenantId = 'default',
        providerType = 'CLOUD_API'
    }) {
        let leads = [];
        if (targetStage === 'ALL') {
            leads = await db.all(`SELECT id, first_name, last_name, company, phone, stage, opted_out, last_inbound_at FROM leads`);
        } else {
            leads = await db.all(`SELECT id, first_name, last_name, company, phone, stage, opted_out, last_inbound_at FROM leads WHERE stage = ?`, [targetStage]);
        }

        let rawTemplate = customMessage;
        if (templateId) {
            const tmpl = await db.get(`SELECT content FROM templates WHERE id = ?`, [templateId]);
            if (tmpl) rawTemplate = tmpl.content;
        }

        const settings = await complianceService.getTenantSettings(tenantId);
        const formattedPreview = complianceService.applyComplianceFormatting(rawTemplate, category, settings);
        const templateValidation = complianceService.validateTemplateContent(rawTemplate, category, settings);

        let eligibleCount = 0;
        let blockedCount = 0;
        const breakdown = {
            missingConsent: 0,
            suppressed: 0,
            invalidPhone: 0,
            optedOut: 0,
            windowExpired: 0,
            templateErrors: templateValidation.valid ? 0 : leads.length
        };

        const contacts = [];

        for (const lead of leads) {
            const norm = normalizePhoneNumber(lead.phone);
            const cleanPhone = (norm && norm.isValid) ? norm.normalized : null;
            let eligible = true;
            let blockReason = '';

            if (!cleanPhone) {
                eligible = false;
                blockReason = 'INVALID_PHONE';
                breakdown.invalidPhone++;
            } else {
                const supp = await complianceService.checkSuppression(tenantId, cleanPhone, category);
                if (supp.suppressed || lead.opted_out) {
                    eligible = false;
                    const reasonText = (supp && supp.record) ? supp.record.reason : 'OPTED_OUT';
                    blockReason = `SUPPRESSED (${reasonText})`;
                    breakdown.suppressed++;
                } else {
                    const consent = await complianceService.checkConsent(tenantId, cleanPhone, category);
                    if (!consent.valid && (settings.enforce_marketing_consent !== 0 || consent.status === 'REVOKED' || consent.status === 'OPTED_OUT')) {
                        eligible = false;
                        blockReason = `MISSING_CONSENT (${consent.reason})`;
                        breakdown.missingConsent++;
                    } else if (providerType === 'CLOUD_API' && settings.enforce_24h_window && !templateId) {
                        const win = await complianceService.check24HourWindow(tenantId, cleanPhone, lead.id);
                        if (!win.withinWindow) {
                            eligible = false;
                            blockReason = 'WINDOW_EXPIRED';
                            breakdown.windowExpired++;
                        }
                    }
                }
            }

            if (!templateValidation.valid) {
                eligible = false;
                blockReason = blockReason ? `${blockReason}; TEMPLATE_INVALID` : 'TEMPLATE_INVALID';
            }

            if (eligible) {
                eligibleCount++;
            } else {
                blockedCount++;
            }

            contacts.push({
                leadId: lead.id,
                name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Lead #' + lead.id,
                phone: lead.phone,
                eligible,
                blockReason
            });
        }

        return {
            totalAudience: leads.length,
            eligibleCount,
            blockedCount,
            breakdown,
            templateValidation,
            formattedPreview,
            optOutFooter: settings.opt_out_footer_text || 'Reply STOP to unsubscribe.',
            contacts: contacts.slice(0, 100)
        };
    }

    async createCampaign({
        name,
        targetStage = 'ALL',
        templateId = null,
        customMessage = '',
        mediaPath = null,
        scheduledAt = null,
        isDraft = false,
        minDelaySeconds = 60,
        maxDelaySeconds = 120,
        batchSize = 25,
        batchDelayMinutes = 10
    }) {
        if (!name || name.trim() === '') {
            throw new Error('Campaign name is required.');
        }

        let messageContent = customMessage;
        if (templateId) {
            const tpl = await db.get(`SELECT * FROM templates WHERE id = ?`, [templateId]);
            if (!tpl) {
                throw new Error(`Template #${templateId} not found or invalid.`);
            }
            if (!messageContent) messageContent = tpl.content;
        }

        if (!messageContent && !mediaPath) {
            throw new Error('Campaign must include message content or a media attachment.');
        }

        // Build target audience
        let leadQuery = `SELECT * FROM leads WHERE phone IS NOT NULL AND phone != ''`;
        const params = [];
        if (targetStage !== 'ALL') {
            leadQuery += ` AND stage = ?`;
            params.push(targetStage);
        }

        const targetLeads = await db.all(leadQuery, params);

        // Deduplicate and filter out invalid phone numbers FIRST
        const seenPhones = new Set();
        const validRecipients = [];
        let skippedCount = 0;

        for (const lead of targetLeads) {
            const { isValid, normalized } = normalizePhoneNumber(lead.phone);
            if (!isValid || seenPhones.has(normalized)) {
                skippedCount++;
                continue;
            }
            seenPhones.add(normalized);
            validRecipients.push({ lead, normalized });
        }

        let initialStatus = 'Queued';
        if (isDraft) {
            initialStatus = 'Draft';
        } else if (scheduledAt && new Date(scheduledAt) > new Date()) {
            initialStatus = 'Scheduled';
        }

        const minDelay = parseInt(minDelaySeconds) || 60;
        const maxDelay = parseInt(maxDelaySeconds) || Math.max(minDelay, 120);
        const bSize = (batchSize !== undefined && batchSize !== null && parseInt(batchSize) >= 0) ? parseInt(batchSize) : 25;
        const bDelayMin = (batchDelayMinutes !== undefined && batchDelayMinutes !== null && parseInt(batchDelayMinutes) >= 0) ? parseInt(batchDelayMinutes) : 10;

        const campRes = await db.run(`
            INSERT INTO campaigns (name, template_id, custom_message, target_stage, total_leads, media_path, scheduled_at, status, min_delay_seconds, max_delay_seconds, skipped_count, batch_size, batch_delay_minutes, current_batch, cooldown_until)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
        `, [
            name.trim(),
            templateId || null,
            customMessage || '',
            targetStage,
            validRecipients.length,
            mediaPath || '',
            scheduledAt || null,
            initialStatus,
            minDelay,
            maxDelay,
            skippedCount,
            bSize,
            bDelayMin
        ]);

        const campaignId = campRes.lastID;

        // Populate recipients with opt-out filter
        for (const item of validRecipients) {
            const isOptedOut = !!item.lead.opted_out;
            const recipientStatus = isOptedOut ? 'SKIPPED_OPT_OUT' : 'PENDING';

            await db.run(`
                INSERT OR IGNORE INTO campaign_recipients (campaign_id, lead_id, phone, status)
                VALUES (?, ?, ?, ?)
            `, [campaignId, item.lead.id, item.normalized, recipientStatus]);
        }

        // If ready to run immediately
        if (initialStatus === 'Queued') {
            this.startCampaign(campaignId).catch(err => {
                console.error(`Failed to dispatch campaign #${campaignId}:`, err);
            });
        }

        return await this.getCampaign(campaignId);
    }

    async getCampaign(id) {
        const campaign = await db.get(`
            SELECT c.*, t.name as template_name 
            FROM campaigns c
            LEFT JOIN templates t ON c.template_id = t.id
            WHERE c.id = ?
        `, [id]);
        if (!campaign) return null;

        const recipientStats = await db.all(`
            SELECT status, COUNT(*) as count 
            FROM campaign_recipients 
            WHERE campaign_id = ? 
            GROUP BY status
        `, [id]);

        let isCoolingDown = false;
        let cooldownSecondsRemaining = 0;
        if (campaign.cooldown_until && campaign.status === 'Running') {
            const untilTime = new Date(campaign.cooldown_until).getTime();
            const nowTime = Date.now();
            if (untilTime > nowTime) {
                isCoolingDown = true;
                cooldownSecondsRemaining = Math.ceil((untilTime - nowTime) / 1000);
            }
        }

        return { 
            ...campaign, 
            recipientStats,
            is_cooling_down: isCoolingDown,
            cooldown_seconds_remaining: cooldownSecondsRemaining
        };
    }

    async skipCooldown(id) {
        const campaign = await db.get(`SELECT * FROM campaigns WHERE id = ?`, [id]);
        if (!campaign) throw new Error(`Campaign #${id} not found.`);

        this.skipCooldownSignals.set(parseInt(id), true);
        await db.run(`
            UPDATE campaigns SET cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `, [id]);

        return { success: true, message: 'Cooldown skipped. Resuming campaign dispatch...' };
    }

    async startCampaign(id) {
        const campaign = await db.get(`SELECT * FROM campaigns WHERE id = ?`, [id]);
        if (!campaign) throw new Error(`Campaign #${id} not found.`);

        this.validateStateTransition(campaign.status, 'Running');

        await db.run(`
            UPDATE campaigns SET status = 'Running', updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `, [id]);

        this.activeDispatchers.set(id, true);
        this.dispatchCampaignRecipients(id);
        return { success: true, status: 'Running' };
    }

    async pauseCampaign(id) {
        const campaign = await db.get(`SELECT * FROM campaigns WHERE id = ?`, [id]);
        if (!campaign) throw new Error(`Campaign #${id} not found.`);

        this.validateStateTransition(campaign.status, 'Paused');

        this.activeDispatchers.set(id, false); // Signal stop
        await db.run(`
            UPDATE campaigns SET status = 'Paused', cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `, [id]);

        return { success: true, status: 'Paused' };
    }

    async resumeCampaign(id) {
        const campaign = await db.get(`SELECT * FROM campaigns WHERE id = ?`, [id]);
        if (!campaign) throw new Error(`Campaign #${id} not found.`);

        this.validateStateTransition(campaign.status, 'Running');

        await db.run(`
            UPDATE campaigns SET status = 'Running', updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `, [id]);

        this.activeDispatchers.set(id, true);
        this.dispatchCampaignRecipients(id);
        return { success: true, status: 'Running' };
    }

    async retryFailed(id) {
        const campaign = await db.get(`SELECT * FROM campaigns WHERE id = ?`, [id]);
        if (!campaign) throw new Error(`Campaign #${id} not found.`);

        // Reset all failed recipients back to PENDING
        const result = await db.run(`
            UPDATE campaign_recipients 
            SET status = 'PENDING', error_message = '' 
            WHERE campaign_id = ? AND (status = 'FAILED' OR status = 'BLOCKED_COMPLIANCE')
        `, [id]);

        if (result.changes === 0) {
            return { success: false, message: 'No failed recipients found to retry.' };
        }

        const currentFailed = Math.max(0, (campaign.failed_count || 0) - result.changes);
        await db.run(`
            UPDATE campaigns 
            SET status = 'Running', failed_count = ?, cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `, [currentFailed, id]);

        this.activeDispatchers.set(id, true);
        this.dispatchCampaignRecipients(id);
        return { success: true, retriedCount: result.changes, status: 'Running' };
    }

    async cancelCampaign(id) {
        const campaign = await db.get(`SELECT * FROM campaigns WHERE id = ?`, [id]);
        if (!campaign) throw new Error(`Campaign #${id} not found.`);

        this.validateStateTransition(campaign.status, 'Cancelled');

        this.activeDispatchers.set(id, false);
        await db.run(`
            UPDATE campaign_recipients 
            SET status = 'CANCELLED' 
            WHERE campaign_id = ? AND status = 'PENDING'
        `, [id]);

        await db.run(`
            UPDATE campaigns SET status = 'Cancelled', cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `, [id]);

        return { success: true, status: 'Cancelled' };
    }

    async dispatchCampaignRecipients(campaignId) {
        try {
            const campaign = await db.get(`
                SELECT c.*, t.content as template_content 
                FROM campaigns c
                LEFT JOIN templates t ON c.template_id = t.id
                WHERE c.id = ?
            `, [campaignId]);

            if (!campaign) return;

            const pendingRecipients = await db.all(`
                SELECT cr.*, l.first_name, l.last_name, l.company, l.email, l.stage, l.opted_out
                FROM campaign_recipients cr
                LEFT JOIN leads l ON cr.lead_id = l.id
                WHERE cr.campaign_id = ? AND cr.status = 'PENDING'
                ORDER BY cr.id ASC
            `, [campaignId]);

            let sentCount = campaign.sent_count || 0;
            let failedCount = campaign.failed_count || 0;
            const isTestEnv = process.env.NODE_ENV === 'test' || 
                              process.argv.some(a => a.includes('test')) || 
                              process.execArgv.some(a => a.includes('test'));
            const minDelaySec = isTestEnv ? 0 : Math.max(1, campaign.min_delay_seconds || 60);
            const maxDelaySec = isTestEnv ? 0 : Math.max(minDelaySec, campaign.max_delay_seconds || 120);

            const batchSize = (campaign.batch_size !== undefined && campaign.batch_size !== null) 
                ? parseInt(campaign.batch_size) 
                : 25;
            const batchDelayMin = (campaign.batch_delay_minutes !== undefined && campaign.batch_delay_minutes !== null) 
                ? parseInt(campaign.batch_delay_minutes) 
                : 10;

            let totalAttempts = sentCount + failedCount;
            let currentBatchNum = campaign.current_batch || (batchSize > 0 ? Math.floor(totalAttempts / batchSize) + 1 : 1);
            let messagesInBatch = batchSize > 0 ? (totalAttempts % batchSize) : 0;

            for (let i = 0; i < pendingRecipients.length; i++) {
                const r = pendingRecipients[i];
                // Check if campaign was paused or cancelled mid-execution
                if (!this.activeDispatchers.get(campaignId)) {
                    console.log(`[Campaign #${campaignId}] Execution stopped (paused or cancelled).`);
                    return;
                }

                // Check opt-out again at send time
                if (r.opted_out) {
                    await db.run(`
                        UPDATE campaign_recipients SET status = 'SKIPPED_OPT_OUT' WHERE id = ?
                    `, [r.id]);
                    continue;
                }

                const rawMsg = campaign.template_content || campaign.custom_message || '';
                const leadObj = {
                    first_name: r.first_name || '',
                    last_name: r.last_name || '',
                    company: r.company || '',
                    phone: r.phone,
                    stage: r.stage || ''
                };
                const tenantId = campaign.tenant_id || 'default';
                const category = campaign.category || 'MARKETING';
                const settings = await complianceService.getTenantSettings(tenantId);
                const rawPersonalized = whatsapp.renderTemplate(rawMsg, leadObj);
                const personalizedMsg = complianceService.applyComplianceFormatting(rawPersonalized, category, settings);

                const activeStatus = whatsapp.getStatus ? whatsapp.getStatus() : {};
                const activeProvider = campaign.provider_type || (activeStatus.activeEngine === 'OPENWA_GATEWAY' ? 'OPENWA' : (activeStatus.activeEngine === 'META_CLOUD_API' ? 'CLOUD_API' : 'WEB'));

                // Centralized compliance & consent check
                const compliance = await complianceService.validateOutboundMessage({
                    tenantId,
                    to: r.phone,
                    leadId: r.lead_id,
                    category,
                    templateId: campaign.template_id,
                    messageBody: personalizedMsg,
                    providerType: activeProvider
                });

                if (!compliance.allowed) {
                    failedCount++;
                    await db.run(`
                        UPDATE campaign_recipients 
                        SET status = 'BLOCKED_COMPLIANCE', error_message = ? 
                        WHERE id = ?
                    `, [compliance.message, r.id]);
                    try {
                        await db.run(`
                            INSERT INTO whatsapp_logs (tenant_id, lead_id, phone, message, media_path, category, direction, status, error_message)
                            VALUES (?, ?, ?, ?, ?, ?, 'OUTGOING', 'BLOCKED_COMPLIANCE', ?)
                        `, [tenantId, r.lead_id || null, r.phone, personalizedMsg, campaign.media_path || '', category, compliance.message]);
                    } catch (e) {}

                    totalAttempts++;
                    await db.run(`
                        UPDATE campaigns 
                        SET sent_count = ?, failed_count = ?, error_message = ?, current_batch = ?, updated_at = CURRENT_TIMESTAMP 
                        WHERE id = ?
                    `, [sentCount, failedCount, compliance.message, currentBatchNum, campaignId]);
                    continue;
                }

                try {
                    await whatsapp.queueMessage({
                        leadId: r.lead_id,
                        phone: r.phone,
                        message: personalizedMsg,
                        mediaPath: campaign.media_path || null,
                        campaignId,
                        tenantId,
                        category,
                        complianceChecked: true
                    });

                    sentCount++;
                    await db.run(`
                        UPDATE campaign_recipients 
                        SET status = 'SENT', sent_at = CURRENT_TIMESTAMP 
                        WHERE id = ?
                    `, [r.id]);
                } catch (err) {
                    failedCount++;
                    await db.run(`
                        UPDATE campaign_recipients 
                        SET status = 'FAILED', error_message = ? 
                        WHERE id = ?
                    `, [err.message, r.id]);
                }

                messagesInBatch++;
                totalAttempts++;

                await db.run(`
                    UPDATE campaigns 
                    SET sent_count = ?, failed_count = ?, current_batch = ?, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                `, [sentCount, failedCount, currentBatchNum, campaignId]);

                // Check if there are more pending recipients after this one
                const hasNext = (i < pendingRecipients.length - 1);
                if (!hasNext) break;

                // Check if batch limit was reached: take a gap of N minutes!
                const isBatchComplete = (batchSize > 0 && messagesInBatch >= batchSize && batchDelayMin > 0);

                if (isBatchComplete) {
                    const cooldownDurationSec = isTestEnv ? 0 : (batchDelayMin * 60);
                    currentBatchNum++;
                    messagesInBatch = 0;

                    if (cooldownDurationSec > 0 && this.activeDispatchers.get(campaignId)) {
                        const cooldownUntil = new Date(Date.now() + cooldownDurationSec * 1000).toISOString();
                        await db.run(`
                            UPDATE campaigns 
                            SET cooldown_until = ?, current_batch = ?, updated_at = CURRENT_TIMESTAMP 
                            WHERE id = ?
                        `, [cooldownUntil, currentBatchNum, campaignId]);

                        console.log(`========================================================================`);
                        console.log(`[Campaign #${campaignId}] BATCH #${currentBatchNum - 1} COMPLETED (${batchSize} messages dispatched).`);
                        console.log(`[Anti-Ban Shield] Pausing for ${batchDelayMin} minutes gap to prevent WhatsApp restrictions.`);
                        console.log(`[Next Batch #${currentBatchNum}] Resuming at ${new Date(Date.now() + cooldownDurationSec * 1000).toLocaleTimeString()} (${pendingRecipients.length - i - 1} leads remaining)...`);
                        console.log(`========================================================================`);

                        // 1-second interval loop allowing Pause, Cancel, or Skip Cooldown
                        for (let s = 0; s < cooldownDurationSec; s++) {
                            if (!this.activeDispatchers.get(campaignId)) break;
                            if (this.skipCooldownSignals.get(campaignId)) {
                                console.log(`[Campaign #${campaignId}] Cooldown skipped by user. Resuming Batch #${currentBatchNum} now!`);
                                this.skipCooldownSignals.delete(campaignId);
                                break;
                            }
                            await new Promise(res => setTimeout(res, 1000));
                        }

                        await db.run(`
                            UPDATE campaigns SET cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
                        `, [campaignId]);

                        if (!this.activeDispatchers.get(campaignId)) return;
                    }
                } else if (this.activeDispatchers.get(campaignId) && maxDelaySec > 0) {
                    // Standard Anti-Ban Randomized Delay between individual messages in the same batch
                    const randomDelaySec = Math.floor(Math.random() * (maxDelaySec - minDelaySec + 1)) + minDelaySec;
                    console.log(`[Campaign #${campaignId}] Batch #${currentBatchNum} (${messagesInBatch}/${batchSize}): Waiting ${randomDelaySec}s before next recipient (${i + 2}/${pendingRecipients.length})...`);
                    
                    for (let s = 0; s < randomDelaySec; s++) {
                        if (!this.activeDispatchers.get(campaignId)) break;
                        await new Promise(res => setTimeout(res, 1000));
                    }
                }
            }

            // Check if all recipients finished
            const remaining = await db.get(`
                SELECT COUNT(*) as count FROM campaign_recipients 
                WHERE campaign_id = ? AND status = 'PENDING'
            `, [campaignId]);

            if (remaining.count === 0 && this.activeDispatchers.get(campaignId)) {
                let finalStatus = 'Completed';
                if (sentCount === 0 && failedCount > 0) {
                    finalStatus = 'Failed';
                }

                await db.run(`
                    UPDATE campaigns 
                    SET status = ?, sent_count = ?, failed_count = ?, cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                `, [finalStatus, sentCount, failedCount, campaignId]);
                this.activeDispatchers.delete(campaignId);
                console.log(`[Campaign #${campaignId}] Finished with status: ${finalStatus}.`);
            }
        } catch (err) {
            console.error(`[Campaign Dispatch Error #${campaignId}]`, err);
            await db.run(`
                UPDATE campaigns 
                SET status = 'Failed', cooldown_until = NULL, error_message = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ?
            `, [err.message, campaignId]);
            this.activeDispatchers.delete(campaignId);
        }
    }
}

const manager = new CampaignManager();
manager.initScheduler();

module.exports = manager;
