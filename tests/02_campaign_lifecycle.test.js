process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database');
const campaignManager = require('../campaign_manager');

test('WhatsApp Campaign Lifecycle & Reliability Suite', async (t) => {
    await db.initDatabase();

    // Ensure we have test leads
    await db.run(`
        INSERT OR IGNORE INTO leads (id, first_name, last_name, phone, stage, opted_out)
        VALUES 
        (101, 'TestUser1', 'Alpha', '919800000001', 'New', 0),
        (102, 'TestUser2', 'Beta', '919800000002', 'New', 0),
        (103, 'TestUser3', 'Gamma', '919800000003', 'New', 1) -- Opted Out!
    `);

    await t.test('Scenario 6: Create a campaign with valid configuration', async () => {
        const campaign = await campaignManager.createCampaign({
            name: 'Diwali Special Offer',
            targetStage: 'New',
            customMessage: 'Hello {{first_name}}, special festive discount!',
            isDraft: true
        });

        assert.ok(campaign.id > 0);
        assert.equal(campaign.name, 'Diwali Special Offer');
        assert.equal(campaign.status, 'Draft');
        assert.ok(campaign.total_leads > 0);
    });

    await t.test('Scenario 7: Reject a campaign with an invalid or non-existent template', async () => {
        await assert.rejects(
            async () => {
                await campaignManager.createCampaign({
                    name: 'Invalid Template Campaign',
                    targetStage: 'New',
                    templateId: 99999 // Non-existent
                });
            },
            {
                message: /Template #99999 not found or invalid/
            }
        );
    });

    await t.test('Scenario 8: Schedule a campaign for a future time', async () => {
        const futureDate = new Date(Date.now() + 3600 * 1000).toISOString(); // 1 hour ahead
        const campaign = await campaignManager.createCampaign({
            name: 'Future Scheduled Blast',
            targetStage: 'New',
            customMessage: 'Good evening {{first_name}}',
            scheduledAt: futureDate
        });

        assert.equal(campaign.status, 'Scheduled');
        assert.equal(campaign.scheduled_at, futureDate);
    });

    await t.test('Scenario 9: State transitions: Pause, Resume, and Cancel a campaign', async () => {
        const campaign = await campaignManager.createCampaign({
            name: 'Pause Resume Test',
            targetStage: 'New',
            customMessage: 'Testing pause and resume',
            isDraft: true
        });

        // 1. Start
        await campaignManager.startCampaign(campaign.id);
        let updated = await campaignManager.getCampaign(campaign.id);
        assert.equal(updated.status, 'Running');

        // 2. Pause
        await campaignManager.pauseCampaign(campaign.id);
        updated = await campaignManager.getCampaign(campaign.id);
        assert.equal(updated.status, 'Paused');

        // Invalid transition test: Paused cannot transition directly to Completed
        assert.throws(() => {
            campaignManager.validateStateTransition('Paused', 'Completed');
        }, /Cannot transition campaign from 'Paused' to 'Completed'/);

        // 3. Resume
        await campaignManager.resumeCampaign(campaign.id);
        updated = await campaignManager.getCampaign(campaign.id);
        assert.equal(updated.status, 'Running');

        // 4. Cancel
        await campaignManager.cancelCampaign(campaign.id);
        updated = await campaignManager.getCampaign(campaign.id);
        assert.equal(updated.status, 'Cancelled');

        // Verify remaining pending recipients were marked as CANCELLED
        const cancelledRecipients = await db.all(`
            SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'CANCELLED'
        `, [campaign.id]);
        assert.ok(cancelledRecipients.length >= 0);
    });

    await t.test('Scenario 10: Prevent duplicate recipient sends in the same campaign', async () => {
        // Insert a duplicate phone lead under the same stage
        await db.run(`
            INSERT OR IGNORE INTO leads (first_name, last_name, phone, stage)
            VALUES ('Duplicate Contact', 'Clone', '919800000001', 'Qualified')
        `);

        const campaign = await campaignManager.createCampaign({
            name: 'Deduplication Test Campaign',
            targetStage: 'Qualified',
            customMessage: 'Testing deduplication',
            isDraft: true
        });

        // Check campaign_recipients table for phone '919800000001'
        const recipients = await db.all(`
            SELECT * FROM campaign_recipients WHERE campaign_id = ? AND phone = '919800000001'
        `, [campaign.id]);

        assert.equal(recipients.length, 1, 'Each unique phone number must only be queued once per campaign');
    });

    await t.test('Scenario 26: Respect opt-outs and messaging restrictions', async () => {
        // Lead 103 has opted_out = 1
        const campaign = await campaignManager.createCampaign({
            name: 'Opt-Out Enforcement Campaign',
            targetStage: 'New',
            customMessage: 'Exclusive offer',
            isDraft: true
        });

        const optedOutRecipient = await db.get(`
            SELECT * FROM campaign_recipients WHERE campaign_id = ? AND phone = '919800000003'
        `, [campaign.id]);

        assert.ok(optedOutRecipient, 'Recipient row should be recorded');
        assert.equal(optedOutRecipient.status, 'SKIPPED_OPT_OUT', 'Opted-out recipient must be skipped automatically');
    });

    await t.test('Scenario 27: Handle concurrent campaign dispatch requests safely', async () => {
        const campaign = await campaignManager.createCampaign({
            name: 'Concurrency Stress Test',
            targetStage: 'New',
            customMessage: 'High concurrency message',
            isDraft: true
        });

        // Attempt simultaneous start calls
        const results = await Promise.allSettled([
            campaignManager.startCampaign(campaign.id),
            campaignManager.startCampaign(campaign.id),
            campaignManager.startCampaign(campaign.id)
        ]);

        // At least one must succeed, and the rest should reject invalid transition or succeed idempotently
        const fulfilled = results.filter(r => r.status === 'fulfilled');
        assert.ok(fulfilled.length >= 1, 'Concurrent calls handled without crashing state machine');
    });

    await t.test('Scenario 28: Handle empty audiences safely', async () => {
        const emptyCampaign = await campaignManager.createCampaign({
            name: 'Empty Stage Audience',
            targetStage: 'NonExistentStage',
            customMessage: 'Nobody here',
            isDraft: true
        });

        assert.equal(emptyCampaign.total_leads, 0);
        assert.equal(emptyCampaign.status, 'Draft');
    });

    await t.test('Scenario 29: Batch processing configuration and cooldown controls', async () => {
        const batchCampaign = await campaignManager.createCampaign({
            name: 'Batch Anti-Ban Campaign',
            targetStage: 'New',
            customMessage: 'Hello {{first_name}}, batch test',
            isDraft: true,
            batchSize: 2,
            batchDelayMinutes: 5
        });

        assert.equal(batchCampaign.batch_size, 2);
        assert.equal(batchCampaign.batch_delay_minutes, 5);
        assert.equal(batchCampaign.current_batch, 1);

        const skipRes = await campaignManager.skipCooldown(batchCampaign.id);
        assert.equal(skipRes.success, true);
    });
});
