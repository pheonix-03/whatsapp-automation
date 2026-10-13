const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database');
const lsqSync = require('../leadsquared_sync');

test('LeadSquared CRM Integration, Mapping & Reliability Suite', async (t) => {
    await db.initDatabase();

    // Ensure mock mode is enabled with valid simulated credentials
    await lsqSync.updateConfig({
        host: 'https://api-us11.leadsquared.com/v2',
        access_key: 'valid_test_access_key',
        secret_key: 'valid_test_secret_key',
        is_enabled: '1',
        mock_mode: '1'
    });

    await t.test('Scenario 16: Create a new LeadSquared lead with mapped attributes', async () => {
        const leadRes = await db.run(`
            INSERT INTO leads (first_name, last_name, email, phone, company, stage, source, score)
            VALUES ('Vikram', 'Bose', 'vikram.bose@enterprise.com', '919876500001', 'Enterprise Corp', 'Qualified', 'Website', 45)
        `);
        const leadId = leadRes.lastID;

        // Enqueue sync
        await lsqSync.enqueueLead(leadId, 'CREATE');
        await lsqSync.processQueue();

        const lead = await db.get(`SELECT * FROM leads WHERE id = ?`, [leadId]);
        assert.equal(lead.sync_status, 'SYNCED', 'Lead should be marked SYNCED');
        assert.ok(lead.leadsquared_id, 'LeadSquared ID must be populated');
        assert.ok(lead.leadsquared_id.startsWith('lsq_'), 'LeadSquared ID must have expected format');
    });

    await t.test('Scenario 17: Update an existing LeadSquared lead', async () => {
        const leadRes = await db.run(`
            INSERT INTO leads (first_name, last_name, phone, stage, leadsquared_id, sync_status)
            VALUES ('Ananya', 'Sen', '919876500002', 'Contacted', 'lsq_existing_123', 'SYNCED')
        `);
        const leadId = leadRes.lastID;

        // Update stage to Proposal Sent
        await db.run(`UPDATE leads SET stage = 'Proposal Sent' WHERE id = ?`, [leadId]);

        await lsqSync.enqueueLead(leadId, 'UPDATE');
        await lsqSync.processQueue();

        const lead = await db.get(`SELECT * FROM leads WHERE id = ?`, [leadId]);
        assert.equal(lead.stage, 'Proposal Sent');
        assert.equal(lead.sync_status, 'SYNCED');
    });

    await t.test('Scenario 18: Prevent duplicate CRM lead creation using SearchBy=Phone deduplication', () => {
        const lead = {
            first_name: 'Sameer',
            last_name: 'Khan',
            phone: '+91 98765-00003',
            email: 'sameer@test.com'
        };

        const attributes = lsqSync.mapLeadToLeadSquaredAttributes(lead);
        const searchByAttr = attributes.find(a => a.Attribute === 'SearchBy');

        assert.ok(searchByAttr, 'SearchBy attribute must be present');
        assert.equal(searchByAttr.Value, 'Phone', 'SearchBy must be set to Phone for deduplication in LeadSquared');

        const phoneAttr = attributes.find(a => a.Attribute === 'Phone');
        assert.equal(phoneAttr.Value, '919876500003', 'Phone must be normalized to international format');
    });

    await t.test('Scenario 19: Handle LeadSquared authentication failure safely (401 Unauthorized)', async () => {
        // Temporarily set invalid keys
        await lsqSync.updateConfig({
            access_key: 'INVALID_KEY',
            secret_key: 'INVALID_SECRET'
        });

        const leadRes = await db.run(`
            INSERT INTO leads (first_name, last_name, phone, stage)
            VALUES ('Auth', 'Tester', '919876500004', 'New')
        `);
        const leadId = leadRes.lastID;

        await lsqSync.enqueueLead(leadId, 'CREATE');
        await lsqSync.processQueue();

        const queueItem = await db.get(`
            SELECT * FROM leadsquared_sync_queue WHERE lead_id = ? ORDER BY id DESC LIMIT 1
        `, [leadId]);

        assert.equal(queueItem.status, 'FAILED', 'Sync must fail cleanly upon auth failure');
        assert.ok(queueItem.last_error.includes('401') || queueItem.last_error.includes('Authentication Failed'));

        // Restore valid credentials
        await lsqSync.updateConfig({
            access_key: 'valid_test_access_key',
            secret_key: 'valid_test_secret_key'
        });
    });

    await t.test('Scenario 20: Recover a failed synchronization with exponential retry backoff', async () => {
        const leadRes = await db.run(`
            INSERT INTO leads (first_name, last_name, phone, stage)
            VALUES ('Timeout', 'RetryTester', 'SIMULATE_TIMEOUT', 'New')
        `);
        const leadId = leadRes.lastID;

        await lsqSync.enqueueLead(leadId, 'CREATE');
        await lsqSync.processQueue();

        // 1st attempt fails with simulated timeout -> moves to RETRY_SCHEDULED
        let queueItem = await db.get(`
            SELECT * FROM leadsquared_sync_queue WHERE lead_id = ? ORDER BY id DESC LIMIT 1
        `, [leadId]);

        assert.equal(queueItem.status, 'RETRY_SCHEDULED', 'Transient failure must schedule retry');
        assert.ok(queueItem.next_retry_at, 'Next retry timestamp must be populated');
        assert.equal(queueItem.attempts, 1);

        // Fix phone number to simulate recovery
        await db.run(`UPDATE leads SET phone = '919876500005' WHERE id = ?`, [leadId]);
        const updatedAttrs = JSON.stringify(lsqSync.mapLeadToLeadSquaredAttributes({
            first_name: 'Timeout',
            last_name: 'RetryTester',
            phone: '919876500005',
            stage: 'New'
        }));

        // Reset next_retry_at to past so queue picks it up
        await db.run(`
            UPDATE leadsquared_sync_queue 
            SET payload = ?, next_retry_at = '2020-01-01 00:00:00' 
            WHERE id = ?
        `, [updatedAttrs, queueItem.id]);

        await lsqSync.processQueue();

        queueItem = await db.get(`SELECT * FROM leadsquared_sync_queue WHERE id = ?`, [queueItem.id]);
        assert.equal(queueItem.status, 'SYNCED', 'Retried sync must recover to SYNCED');
    });

    await t.test('Scenario 21: Preserve field mappings and campaign attribution', () => {
        const lead = {
            first_name: 'Pooja',
            last_name: 'Hegde',
            email: 'pooja@studio.in',
            phone: '919811223344',
            company: 'Studio Media',
            stage: 'Qualified',
            source: 'WhatsApp Campaign Q3',
            score: 75
        };

        const attributes = lsqSync.mapLeadToLeadSquaredAttributes(lead);
        const map = {};
        for (const a of attributes) map[a.Attribute] = a.Value;

        assert.equal(map['FirstName'], 'Pooja');
        assert.equal(map['LastName'], 'Hegde');
        assert.equal(map['EmailAddress'], 'pooja@studio.in');
        assert.equal(map['Company'], 'Studio Media');
        assert.equal(map['ProspectStage'], 'Qualified');
        assert.equal(map['Source'], 'WhatsApp Campaign Q3');
        assert.equal(map['mx_Lead_Score'], '75');
    });

    await t.test('Scenario 22: Handle missing optional lead fields safely', () => {
        const minimalLead = {
            first_name: 'MinimalUser',
            phone: '919800001111'
        };

        const attributes = lsqSync.mapLeadToLeadSquaredAttributes(minimalLead);
        const map = {};
        for (const a of attributes) map[a.Attribute] = a.Value;

        assert.equal(map['FirstName'], 'MinimalUser');
        assert.equal(map['LastName'], '');
        assert.equal(map['Phone'], '919800001111');
        assert.equal(map['ProspectStage'], 'New');
        assert.equal(map['EmailAddress'], undefined);
        assert.equal(map['Company'], undefined);
    });

    await t.test('Scenario 23: Reject unauthorized operations or invalid configurations', async () => {
        // Missing credentials must be rejected
        await assert.rejects(
            async () => {
                await lsqSync.sendToLeadSquaredAPI(
                    { access_key: '', secret_key: '' },
                    [{ Attribute: 'FirstName', Value: 'Test' }]
                );
            },
            {
                message: /credentials missing/
            }
        );
    });

    await t.test('Scenario 24: Recover after worker restart: resume uncompleted queue items', async () => {
        // Create an item stuck in PENDING from an aborted process
        const stuckLead = await db.run(`
            INSERT INTO leads (first_name, phone, stage)
            VALUES ('StuckWorker', '919800002222', 'New')
        `);
        const payload = JSON.stringify(lsqSync.mapLeadToLeadSquaredAttributes({
            first_name: 'StuckWorker',
            phone: '919800002222',
            stage: 'New'
        }));
        const stuckQueue = await db.run(`
            INSERT INTO leadsquared_sync_queue (lead_id, operation, payload, status)
            VALUES (?, 'CREATE', ?, 'PENDING')
        `, [stuckLead.lastID, payload]);

        // "Restart" worker: call processQueue anew
        await lsqSync.processQueue();

        const recovered = await db.get(`SELECT * FROM leadsquared_sync_queue WHERE id = ?`, [stuckQueue.lastID]);
        assert.equal(recovered.status, 'SYNCED', 'Orphaned pending queue item must be picked up and synced');
    });

    await t.test('Scenario 29: Verify pagination and sync metrics reporting', async () => {
        const syncStatus = await lsqSync.getSyncStatus();

        assert.ok(syncStatus.config, 'Config summary should be present');
        assert.ok(syncStatus.stats, 'Queue status counts should be present');
        assert.ok(Array.isArray(syncStatus.recentQueue), 'Recent queue items array should be present');
        assert.ok(syncStatus.recentQueue.length <= 20, 'Queue items should be bounded / paginated');
    });
});
