const db = require('./database');
const complianceService = require('./compliance_service');
const { normalizePhoneNumber } = require('./whatsapp_links');

function extractCleanPhone(input) {
    if (!input) return null;
    if (typeof input === 'object' && input.normalized) return input.normalized;
    const res = normalizePhoneNumber(input);
    if (res && res.isValid && res.normalized) return res.normalized;
    const digits = String(input).replace(/\D/g, '');
    return digits.length >= 8 ? digits : null;
}

class ComplianceGuardQueue {
    constructor(options = {}) {
        this.maxConcurrency = options.maxConcurrency || 5;
        this.activeWorkers = 0;
        this.queue = [];
        this.isProcessing = false;
        
        // Rate limiting: 60 messages per minute default
        this.rateLimitPerMinute = options.rateLimitPerMinute || 60;
        this.dispatchedTimestamps = [];

        // Backoff configuration
        this.baseBackoffMs = options.baseBackoffMs || 50; // Fast in tests/dev, bounded
        this.maxBackoffMs = options.maxBackoffMs || 1000;
        this.defaultMaxRetries = options.defaultMaxRetries || 3;
    }

    /**
     * Determine if an error is transient (retryable) vs permanent (non-retryable)
     */
    isTransientError(err) {
        if (!err) return false;
        const msg = String(err.message || '').toLowerCase();
        const status = err.status || err.statusCode || (err.response && err.response.status);

        // Permanent error indicators: NEVER retry
        if (
            status === 400 || 
            status === 401 || 
            status === 403 || 
            status === 404 || 
            msg.includes('invalid number') || 
            msg.includes('invalid_phone') ||
            msg.includes('blocked') ||
            msg.includes('unauthorized') ||
            msg.includes('opted out') ||
            msg.includes('no_consent') ||
            msg.includes('suppressed') ||
            msg.includes('template rejected')
        ) {
            return false;
        }

        // Transient error indicators: safe to retry with backoff
        if (
            status === 429 || 
            status === 500 || 
            status === 502 || 
            status === 503 || 
            status === 504 || 
            msg.includes('rate limit') || 
            msg.includes('timeout') || 
            msg.includes('network') ||
            msg.includes('econnreset') ||
            msg.includes('etimedout') ||
            msg.includes('service unavailable')
        ) {
            return true;
        }

        return false;
    }

    /**
     * Enqueue a message for safe throttled dispatch with pre-wire compliance guard
     */
    enqueue({
        tenantId = 'default',
        leadId = null,
        to,
        category = 'MARKETING',
        templateId = null,
        messageBody = '',
        mediaPath = null,
        providerType = 'CLOUD_API',
        maxRetries = this.defaultMaxRetries,
        sendFn = null
    }) {
        const cleanPhone = extractCleanPhone(to);
        if (!cleanPhone) {
            return Promise.reject(new Error(`Invalid phone number: '${to}'`));
        }

        return new Promise((resolve, reject) => {
            const task = {
                id: `cgq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                tenantId,
                leadId,
                cleanPhone,
                category,
                templateId,
                messageBody,
                mediaPath,
                providerType,
                attempts: 0,
                maxRetries,
                sendFn,
                resolve,
                reject,
                createdAt: Date.now()
            };

            this.queue.push(task);
            this.processQueue();
        });
    }

    /**
     * Cancel all queued tasks for a phone (e.g. on opt-out)
     */
    cancelForPhone(phone, reason = 'Opted out while queued') {
        const cleanPhone = extractCleanPhone(phone) || phone;
        const initialCount = this.queue.length;
        this.queue = this.queue.filter(task => {
            if (task.cleanPhone === cleanPhone || task.cleanPhone.endsWith(cleanPhone.slice(-10))) {
                task.reject(new Error(`Message cancelled: ${reason}`));
                return false;
            }
            return true;
        });
        return initialCount - this.queue.length;
    }

    /**
     * Process items from the queue with concurrency and rate limits
     */
    async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.queue.length > 0 && this.activeWorkers < this.maxConcurrency) {
            // Check rate limits
            const now = Date.now();
            this.dispatchedTimestamps = this.dispatchedTimestamps.filter(t => now - t < 60000);
            if (this.dispatchedTimestamps.length >= this.rateLimitPerMinute) {
                // Rate limited: wait 200ms and re-check
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            const task = this.queue.shift();
            if (!task) break;

            this.activeWorkers++;
            this.dispatchedTimestamps.push(Date.now());

            // Run task worker
            this.dispatchTask(task).finally(() => {
                this.activeWorkers--;
                this.processQueue();
            });
        }

        this.isProcessing = false;
    }

    /**
     * Execute single task dispatch with FINAL compliance check right before wire send
     */
    async dispatchTask(task) {
        task.attempts++;

        // CRITICAL: Final Compliance Check immediately before wire send
        const compliance = await complianceService.validateOutboundMessage({
            tenantId: task.tenantId,
            to: task.cleanPhone,
            leadId: task.leadId,
            category: task.category,
            templateId: task.templateId,
            messageBody: task.messageBody,
            providerType: task.providerType
        });

        if (!compliance.allowed) {
            const blockError = new Error(`Compliance Guard Blocked Dispatch: ${compliance.message} (${compliance.reason})`);
            blockError.complianceBlocked = true;
            blockError.reason = compliance.reason;

            // Log dead letter / block in DB
            try {
                await db.run(`
                    INSERT INTO whatsapp_logs 
                    (tenant_id, lead_id, phone, message, category, direction, status, error_message)
                    VALUES (?, ?, ?, ?, ?, 'OUTGOING', 'BLOCKED_COMPLIANCE', ?)
                `, [task.tenantId, task.leadId, task.cleanPhone, task.messageBody, task.category, compliance.message]);
            } catch (e) {}

            task.reject(blockError);
            return;
        }

        // Wire dispatch execution
        try {
            let result;
            if (typeof task.sendFn === 'function') {
                result = await task.sendFn(task);
            } else {
                // Default sandbox / mock provider dispatch
                result = {
                    success: true,
                    providerMessageId: `wamid_guard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    status: 'SUBMITTED'
                };
            }

            task.resolve(result);
        } catch (err) {
            const isTransient = this.isTransientError(err);

            if (isTransient && task.attempts < task.maxRetries) {
                // Calculate bounded exponential backoff
                const backoffDelay = Math.min(
                    this.maxBackoffMs,
                    this.baseBackoffMs * Math.pow(2, task.attempts - 1)
                );
                console.warn(`[Queue Transient Error] Task ${task.id} attempt ${task.attempts}/${task.maxRetries} failed (${err.message}). Retrying in ${backoffDelay}ms...`);

                await new Promise(r => setTimeout(r, backoffDelay));
                // Re-enqueue task
                this.queue.unshift(task);
            } else {
                // Permanent error OR retries exhausted -> Dead Letter
                console.error(`[Queue Dead-Letter] Task ${task.id} permanent failure or exhausted (${err.message}). No further retries.`);
                
                try {
                    await db.run(`
                        INSERT INTO whatsapp_logs 
                        (tenant_id, lead_id, phone, message, category, direction, status, error_message)
                        VALUES (?, ?, ?, ?, ?, 'OUTGOING', 'FAILED', ?)
                    `, [task.tenantId, task.leadId, task.cleanPhone, task.messageBody, task.category, `Dead-letter: ${err.message}`]);
                } catch (e) {}

                task.reject(err);
            }
        }
    }
}

const queue = new ComplianceGuardQueue();
module.exports = queue;
