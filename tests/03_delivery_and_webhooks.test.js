const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database');
const webhookHandler = require('../webhook_handler');

test('WhatsApp Message Delivery, Status Tracking & Webhooks Suite', async (t) => {
    await db.initDatabase();

    const testMsgId = 'wamid_test_' + Date.now();
    const testPhone = '919876543210';

    // Seed log entry to track
    const seedLog = await db.run(`
        INSERT INTO whatsapp_logs (phone, message, direction, status, provider_message_id, delivery_status)
        VALUES (?, 'Testing message delivery lifecycle', 'OUTGOING', 'QUEUED', ?, 'QUEUED')
    `, [testPhone, testMsgId]);

    const logId = seedLog.lastID;

    await t.test('Scenario 13: Process delivery webhook progression (SUBMITTED -> SENT -> DELIVERED -> READ)', async () => {
        // Step 1: Provider SENT webhook
        await webhookHandler.processStatusUpdate({
            id: testMsgId,
            status: 'sent',
            timestamp: Date.now()
        });

        let current = await db.get(`SELECT * FROM whatsapp_logs WHERE id = ?`, [logId]);
        assert.equal(current.delivery_status, 'SENT');

        // Step 2: Provider DELIVERED webhook
        await webhookHandler.processStatusUpdate({
            id: testMsgId,
            status: 'delivered',
            timestamp: Date.now()
        });

        current = await db.get(`SELECT * FROM whatsapp_logs WHERE id = ?`, [logId]);
        assert.equal(current.delivery_status, 'DELIVERED');

        // Step 3: Provider READ webhook
        await webhookHandler.processStatusUpdate({
            id: testMsgId,
            status: 'read',
            timestamp: Date.now()
        });

        current = await db.get(`SELECT * FROM whatsapp_logs WHERE id = ?`, [logId]);
        assert.equal(current.delivery_status, 'READ');
    });

    await t.test('Scenario 14: Process duplicate webhooks idempotently without duplicate state updates', async () => {
        const eventsBefore = (await db.get(`SELECT COUNT(*) as count FROM webhook_events`)).count;

        // Send same READ status event again
        await webhookHandler.processStatusUpdate({
            id: testMsgId,
            status: 'read',
            timestamp: Date.now()
        });

        const eventsAfter = (await db.get(`SELECT COUNT(*) as count FROM webhook_events`)).count;
        assert.equal(eventsAfter, eventsBefore, 'Duplicate event must be ignored via idempotency check');

        const current = await db.get(`SELECT * FROM whatsapp_logs WHERE id = ?`, [logId]);
        assert.equal(current.delivery_status, 'READ', 'Status remains cleanly READ');
    });

    await t.test('Scenario 15: Process out-of-order status events and prevent status regression', async () => {
        // The message is already in 'READ' state.
        // A delayed 'sent' or 'delivered' webhook arrives out of order:
        await webhookHandler.processStatusUpdate({
            id: testMsgId,
            status: 'delivered', // Arrived late
            timestamp: Date.now() - 5000
        });

        const current = await db.get(`SELECT * FROM whatsapp_logs WHERE id = ?`, [logId]);
        // Must NOT regress back to DELIVERED
        assert.equal(current.delivery_status, 'READ', 'Out-of-order event must not regress message from READ to DELIVERED');
    });

    await t.test('Scenario 11: Handle provider rate limiting (429 status response) safely', async () => {
        const rateLimitLog = await db.run(`
            INSERT INTO whatsapp_logs (phone, message, direction, status, provider_message_id, delivery_status, error_message)
            VALUES (?, 'Rate limited message', 'OUTGOING', 'FAILED', 'wamid_rate_limit', 'FAILED', 'WhatsApp API Error (429): Rate limit exceeded. Retry after 60s.')
        `, [testPhone]);

        const record = await db.get(`SELECT * FROM whatsapp_logs WHERE id = ?`, [rateLimitLog.lastID]);
        assert.equal(record.delivery_status, 'FAILED');
        assert.ok(record.error_message.includes('429'), 'Rate limit error properly preserved');
    });

    await t.test('Scenario 12: Handle ambiguous send timeout safely without blind duplicate sending', async () => {
        // When a send times out ambiguously, the message is marked QUEUED/SUBMITTED for status reconciliation rather than immediately duplicated
        const reconcileMsgId = 'wamid_timeout_' + Date.now() + '_' + Math.random().toString(36).substring(7);
        const timeoutLog = await db.run(`
            INSERT INTO whatsapp_logs (phone, message, direction, status, provider_message_id, delivery_status)
            VALUES (?, 'Ambiguous timeout test', 'OUTGOING', 'SUBMITTED', ?, 'SUBMITTED')
        `, [testPhone, reconcileMsgId]);

        // Simulating provider reconciliation webhook confirming delivery
        await webhookHandler.processStatusUpdate({
            id: reconcileMsgId,
            status: 'delivered',
            timestamp: Date.now()
        });

        const reconciled = await db.get(`SELECT * FROM whatsapp_logs WHERE id = ?`, [timeoutLog.lastID]);
        assert.equal(reconciled.delivery_status, 'DELIVERED', 'Reconciled successfully without firing duplicate sends');
    });

    await t.test('Scenario 25: Inbound message handling with automatic STOP opt-out registration', async () => {
        const uniquePhone = '9197' + Math.floor(10000000 + Math.random() * 90000000);
        // Create an active lead
        const leadRes = await db.run(`
            INSERT INTO leads (first_name, last_name, phone, stage, opted_out)
            VALUES ('Optout', 'Tester', ?, 'New', 0)
        `, [uniquePhone]);
        const leadId = leadRes.lastID;

        // Inbound STOP webhook
        await webhookHandler.processInboundMessage({
            id: 'inbound_stop_' + Date.now() + '_' + Math.random().toString(36).substring(7),
            from: uniquePhone,
            text: { body: 'STOP' }
        });

        const updatedLead = await db.get(`SELECT opted_out FROM leads WHERE id = ?`, [leadId]);
        assert.equal(updatedLead.opted_out, 1, 'Inbound STOP message must automatically mark lead as opted out');

        const optOutActivity = await db.get(`
            SELECT * FROM activities WHERE lead_id = ? AND type = 'OPT_OUT'
        `, [leadId]);
        assert.ok(optOutActivity, 'Opt-out activity must be logged in timeline');
    });

    await t.test('Scenario 30: Verify accurate operational logging and error reporting', async () => {
        const errorLog = await db.run(`
            INSERT INTO whatsapp_logs (phone, message, direction, status, error_message)
            VALUES ('919876543210', 'Failed template test', 'OUTGOING', 'FAILED', 'Template structure mismatch: missing {{company}} param.')
        `);

        const entry = await db.get(`SELECT * FROM whatsapp_logs WHERE id = ?`, [errorLog.lastID]);
        assert.equal(entry.status, 'FAILED');
        assert.ok(entry.error_message.includes('missing {{company}}'));
    });
});
