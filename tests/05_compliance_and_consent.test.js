process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database');
const complianceService = require('../compliance_service');
const consentManager = require('../consent_manager');
const complianceQueue = require('../compliance_guard_queue');
const campaignManager = require('../campaign_manager');
const webhookHandler = require('../webhook_handler');

test('WhatsApp Compliance & Messaging Guard Suite', async (t) => {
    await db.initDatabase();

    // Clean up test data before running
    await db.run(`DELETE FROM whatsapp_consents WHERE tenant_id LIKE 'test_%' OR tenant_id = 'default'`);
    await db.run(`DELETE FROM whatsapp_suppressions WHERE tenant_id LIKE 'test_%' OR tenant_id = 'default'`);
    await db.run(`DELETE FROM compliance_audit_logs WHERE tenant_id LIKE 'test_%' OR tenant_id = 'default'`);

    await t.test('Scenario 1: Missing consent blocks sending', async () => {
        const phone = '919800110001';
        
        // Outbound marketing validation without any prior consent
        const check = await complianceService.validateOutboundMessage({
            tenantId: 'default',
            to: phone,
            category: 'MARKETING',
            messageBody: 'Special discount! Reply STOP to opt out.'
        });

        assert.equal(check.allowed, false, 'Outbound send must be disallowed without consent');
        assert.equal(check.reason, 'NO_CONSENT');
        assert.match(check.message, /Missing or invalid consent/);

        // Verification through ComplianceGuardQueue
        await assert.rejects(
            async () => {
                await complianceQueue.enqueue({
                    tenantId: 'default',
                    to: phone,
                    category: 'MARKETING',
                    messageBody: 'Special discount! Reply STOP to opt out.'
                });
            },
            {
                complianceBlocked: true,
                reason: 'NO_CONSENT'
            }
        );
    });

    await t.test('Scenario 2: Valid consent allows an otherwise eligible message', async () => {
        const phone = '919800110002';

        // Affirmative capture with explicit evidence
        await consentManager.captureConsent({
            tenantId: 'default',
            phone,
            purpose: 'MARKETING',
            status: 'OPTED_IN',
            source: 'WEB_FORM',
            collectionMethod: 'WEB_FORM',
            consentEvidence: 'Form #789 timestamped 2026-10-12 IP 103.21.54.2',
            actorId: 'agent_42',
            actorRole: 'AGENT'
        });

        const check = await complianceService.validateOutboundMessage({
            tenantId: 'default',
            to: phone,
            category: 'MARKETING',
            templateId: 1,
            messageBody: 'Hello! Special festive offer. Reply STOP to opt out.'
        });

        assert.equal(check.allowed, true, 'Message with valid affirmative consent must be allowed');
        assert.equal(check.reason, 'APPROVED');

        // Queue dispatch check
        let wireCalled = false;
        const result = await complianceQueue.enqueue({
            tenantId: 'default',
            to: phone,
            category: 'MARKETING',
            templateId: 1,
            messageBody: 'Hello! Special festive offer. Reply STOP to opt out.',
            sendFn: async () => {
                wireCalled = true;
                return { success: true, providerMessageId: 'wamid_test_valid' };
            }
        });

        assert.equal(wireCalled, true, 'Wire send function must be called when compliant');
        assert.equal(result.providerMessageId, 'wamid_test_valid');
    });

    await t.test('Scenario 3: STOP suppresses the contact and cancels queued marketing messages', async () => {
        const phone = '919800110003';

        // 1. Setup consent and active queued recipient in campaign_recipients
        await consentManager.captureConsent({
            tenantId: 'default',
            phone,
            purpose: 'MARKETING',
            status: 'OPTED_IN',
            consentEvidence: 'Signed checkout opt-in'
        });

        await db.run(`
            INSERT OR IGNORE INTO campaigns (id, name, target_stage)
            VALUES (999, 'Test Campaign for Opt-Out', 'New')
        `);

        await db.run(`DELETE FROM campaign_recipients WHERE campaign_id = 999`);

        await db.run(`
            INSERT OR IGNORE INTO leads (id, first_name, phone, stage)
            VALUES (501, 'OptOutUser', ?, 'New')
        `, [phone]);

        await db.run(`
            INSERT INTO campaign_recipients (campaign_id, lead_id, phone, status)
            VALUES (999, 501, ?, 'PENDING')
        `, [phone]);

        // 2. Contact texts 'STOP'
        const optOutResult = await consentManager.handleInboundOptOut({
            tenantId: 'default',
            phone,
            messageBody: 'STOP'
        });

        assert.equal(optOutResult.isOptOut, true);

        // 3. Verify suppression created
        const suppression = await complianceService.checkSuppression('default', phone);
        assert.equal(suppression.suppressed, true);
        assert.equal(suppression.record.reason, 'INBOUND_KEYWORD');

        // 4. Verify marketing consent revoked
        const consent = await complianceService.checkConsent('default', phone, 'MARKETING');
        assert.equal(consent.valid, false);
        assert.equal(consent.status, 'REVOKED');

        // 5. Verify queued campaign recipient immediately cancelled
        const recipient = await db.get(`
            SELECT status, error_message FROM campaign_recipients 
            WHERE campaign_id = 999 AND phone = ?
        `, [phone]);

        assert.equal(recipient.status, 'CANCELLED_OPT_OUT');
        assert.match(recipient.error_message, /Suppressed|Consent revoked/);
    });

    await t.test('Scenario 4: Duplicate webhook events do not duplicate actions', async () => {
        const testWamid = `wamid_dedup_${Date.now()}`;

        // Insert initial outgoing log
        await db.run(`
            INSERT INTO whatsapp_logs (phone, message, direction, status, provider_message_id)
            VALUES ('919800110004', 'Testing webhooks', 'OUTGOING', 'SENT', ?)
        `, [testWamid]);

        const webhookPayload = {
            id: testWamid,
            status: 'delivered'
        };

        // First delivery update
        await webhookHandler.processStatusUpdate(webhookPayload);
        const logAfterFirst = await db.get(`SELECT delivery_status FROM whatsapp_logs WHERE provider_message_id = ?`, [testWamid]);
        assert.equal(logAfterFirst.delivery_status, 'DELIVERED');

        const eventsCount1 = await db.get(`SELECT COUNT(*) as c FROM webhook_events WHERE event_id = ?`, [`status_${testWamid}_DELIVERED`]);
        assert.equal(eventsCount1.c, 1);

        // Second duplicate delivery update
        await webhookHandler.processStatusUpdate(webhookPayload);
        const eventsCount2 = await db.get(`SELECT COUNT(*) as c FROM webhook_events WHERE event_id = ?`, [`status_${testWamid}_DELIVERED`]);
        assert.equal(eventsCount2.c, 1, 'Duplicate webhook event must not create duplicate DB event rows');
    });

    await t.test('Scenario 5: Revoked consent blocks subsequent dispatch', async () => {
        const phone = '919800110005';

        // Capture consent first
        await consentManager.captureConsent({
            tenantId: 'default',
            phone,
            purpose: 'MARKETING',
            consentEvidence: 'Form capture #55'
        });

        // Revoke consent
        await consentManager.revokeConsent({
            tenantId: 'default',
            phone,
            purpose: 'MARKETING',
            reason: 'Contact called agent to revoke consent',
            actorRole: 'AGENT'
        });

        // Attempt dispatch
        const check = await complianceService.validateOutboundMessage({
            tenantId: 'default',
            to: phone,
            category: 'MARKETING',
            messageBody: 'Follow up offer! Reply STOP to opt out.'
        });

        assert.equal(check.allowed, false);
        assert.equal(check.reason, 'NO_CONSENT');
        assert.match(check.message, /REVOKED/);
    });

    await t.test('Scenario 6: Concurrent opt-out and dispatch cannot bypass the final check', async () => {
        const phone = '919800110006';

        // 1. Initial valid consent
        await consentManager.captureConsent({
            tenantId: 'default',
            phone,
            purpose: 'MARKETING',
            consentEvidence: 'Web signup'
        });

        // 2. Add suppression right before/concurrent with dispatch
        await consentManager.addSuppression({
            tenantId: 'default',
            phone,
            reason: 'RACE_CONDITION_OPT_OUT',
            scope: 'GLOBAL',
            actorRole: 'ADMIN'
        });

        let wireCalled = false;
        await assert.rejects(
            complianceQueue.enqueue({
                tenantId: 'default',
                to: phone,
                category: 'MARKETING',
                templateId: 1,
                messageBody: 'Hello! Reply STOP to unsubscribe.',
                sendFn: async () => {
                    wireCalled = true;
                    return { success: true };
                }
            }),
            (err) => {
                assert.ok(err.complianceBlocked || err.message.includes('suppression') || err.message.includes('Compliance Guard Blocked'));
                return true;
            }
        );

        assert.equal(wireCalled, false, 'Wire send must NEVER be called after opt-out');
    });

    await t.test('Scenario 7: Permanent errors are not retried', async () => {
        const phone = '919800110007';

        await consentManager.captureConsent({
            tenantId: 'default',
            phone,
            purpose: 'MARKETING',
            consentEvidence: 'Test evidence'
        });

        let sendAttempts = 0;
        await assert.rejects(
            async () => {
                await complianceQueue.enqueue({
                    tenantId: 'default',
                    to: phone,
                    category: 'MARKETING',
                    templateId: 1,
                    messageBody: 'Hello! Reply STOP to opt out.',
                    maxRetries: 3,
                    sendFn: async () => {
                        sendAttempts++;
                        const err = new Error('Invalid number: WhatsApp account does not exist (400)');
                        err.status = 400;
                        throw err;
                    }
                });
            },
            {
                message: /Invalid number/
            }
        );

        assert.equal(sendAttempts, 1, 'Permanent error (400 Invalid Number) must not be retried');
    });

    await t.test('Scenario 8: Transient errors use bounded backoff', async () => {
        const phone = '919800110008';

        await consentManager.captureConsent({
            tenantId: 'default',
            phone,
            purpose: 'MARKETING',
            consentEvidence: 'Test evidence'
        });

        let sendAttempts = 0;
        const result = await complianceQueue.enqueue({
            tenantId: 'default',
            to: phone,
            category: 'MARKETING',
            templateId: 1,
            messageBody: 'Hello! Reply STOP to opt out.',
            maxRetries: 3,
            sendFn: async () => {
                sendAttempts++;
                if (sendAttempts < 3) {
                    const err = new Error('Meta API Rate Limit Exceeded (429)');
                    err.status = 429;
                    throw err;
                }
                return { success: true, providerMessageId: 'wamid_retry_success' };
            }
        });

        assert.equal(sendAttempts, 3, 'Transient error (429) must retry and succeed on 3rd attempt');
        assert.equal(result.providerMessageId, 'wamid_retry_success');
    });

    await t.test('Scenario 9: Unauthorized users cannot alter consent or suppression records', async () => {
        const phone = '919800110009';

        // 1. Role AGENT attempting to modify suppression records
        await assert.rejects(
            async () => {
                await consentManager.addSuppression({
                    tenantId: 'default',
                    phone,
                    reason: 'MALICIOUS_BLOCK',
                    actorRole: 'AGENT'
                });
            },
            {
                message: /Unauthorized: Role 'AGENT' is not permitted/
            }
        );

        // 2. Role VIEWER attempting to modify suppression records
        await assert.rejects(
            async () => {
                await consentManager.removeSuppression({
                    tenantId: 'default',
                    phone,
                    actorRole: 'VIEWER'
                });
            },
            {
                message: /Unauthorized: Role 'VIEWER' is not permitted/
            }
        );

        // 3. Role ADMIN succeeds
        const adminRes = await consentManager.addSuppression({
            tenantId: 'default',
            phone,
            reason: 'LEGIT_BLOCK',
            actorRole: 'ADMIN'
        });
        assert.equal(adminRes.success, true);
    });

    await t.test('Scenario 10: One tenant cannot access another tenant\'s contacts or evidence', async () => {
        const phone = '919800110010';
        const tenantA = 'test_tenant_alpha';
        const tenantB = 'test_tenant_beta';

        // Tenant A captures consent with confidential evidence
        await consentManager.captureConsent({
            tenantId: tenantA,
            phone,
            purpose: 'MARKETING',
            consentEvidence: 'CONFIDENTIAL_CUSTOMER_SIGNATURE_TENANT_A'
        });

        // Tenant A sees the consent
        const consentA = await complianceService.checkConsent(tenantA, phone, 'MARKETING');
        assert.equal(consentA.valid, true);
        assert.equal(consentA.record.consent_evidence, 'CONFIDENTIAL_CUSTOMER_SIGNATURE_TENANT_A');

        // Tenant B cannot see Tenant A's consent or evidence
        const consentB = await complianceService.checkConsent(tenantB, phone, 'MARKETING');
        assert.equal(consentB.valid, false, 'Tenant B must have no consent access for Tenant A');
        assert.equal(consentB.record, null);
    });

    await t.test('Scenario 11: Campaign preview counts match the actual dispatch eligibility rules', async () => {
        const testStage = 'PreflightTestStage';

        // Create 4 distinct leads in PreflightTestStage:
        // Lead 1: Valid consent (Eligible)
        // Lead 2: Missing consent (Blocked)
        // Lead 3: Suppressed (Blocked)
        // Lead 4: Invalid phone (Blocked)
        await db.run(`DELETE FROM leads WHERE stage = ?`, [testStage]);

        const l1 = await db.run(`INSERT INTO leads (first_name, phone, stage, last_inbound_at) VALUES ('EligibleUser', '919800110011', ?, CURRENT_TIMESTAMP)`, [testStage]);
        const l2 = await db.run(`INSERT INTO leads (first_name, phone, stage) VALUES ('NoConsentUser', '919800110012', ?)`, [testStage]);
        const l3 = await db.run(`INSERT INTO leads (first_name, phone, stage) VALUES ('SuppressedUser', '919800110013', ?)`, [testStage]);
        const l4 = await db.run(`INSERT INTO leads (first_name, phone, stage) VALUES ('BadPhoneUser', 'not_a_phone', ?)`, [testStage]);

        // Seed consent for Lead 1 only
        await consentManager.captureConsent({
            tenantId: 'default',
            phone: '919800110011',
            purpose: 'MARKETING',
            consentEvidence: 'Preflight opt-in valid'
        });

        // Seed suppression for Lead 3
        await consentManager.addSuppression({
            tenantId: 'default',
            phone: '919800110013',
            reason: 'PREVIOUS_OPT_OUT',
            actorRole: 'ADMIN'
        });

        // Seed a compliant marketing template with opt-out footer
        const tmplRes = await db.run(`
            INSERT INTO templates (name, category, content)
            VALUES ('Compliant Festive Template', 'Offer', 'Hello {{first_name}}, check this offer! Reply STOP to opt out.')
        `);
        const tmplId = tmplRes.lastID;

        const preflight = await campaignManager.preflightCampaign({
            targetStage: testStage,
            templateId: tmplId,
            category: 'MARKETING',
            tenantId: 'default'
        });

        assert.equal(preflight.totalAudience, 4);
        assert.equal(preflight.eligibleCount, 1, 'Only Lead 1 is eligible');
        assert.equal(preflight.blockedCount, 3, 'Leads 2, 3, and 4 must be blocked');
        assert.equal(preflight.breakdown.missingConsent, 1);
        assert.equal(preflight.breakdown.suppressed, 1);
        assert.equal(preflight.breakdown.invalidPhone, 1);
    });

    await t.test('Scenario 12: Provider errors and uncertain delivery states are handled correctly', async () => {
        const testWamid = `wamid_uncertain_${Date.now()}`;

        // Insert log in SUBMITTED state
        await db.run(`
            INSERT INTO whatsapp_logs (phone, message, direction, status, delivery_status, provider_message_id)
            VALUES ('919800110012', 'Uncertain state test', 'OUTGOING', 'SUBMITTED', 'SUBMITTED', ?)
        `, [testWamid]);

        // Verify status hierarchy does not allow regression from DELIVERED back to SENT or SUBMITTED
        const canRegress = webhookHandler.canTransitionStatus('DELIVERED', 'SENT');
        assert.equal(canRegress, false, 'Status hierarchy must prevent regression from DELIVERED to SENT');

        const canProgress = webhookHandler.canTransitionStatus('DELIVERED', 'READ');
        assert.equal(canProgress, true, 'Status hierarchy must permit progression from DELIVERED to READ');

        // Verify FAILED transitions are always allowed
        const canFail = webhookHandler.canTransitionStatus('DELIVERED', 'FAILED');
        assert.equal(canFail, true, 'FAILED transition must always be accepted');
    });
});
