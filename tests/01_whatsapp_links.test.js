const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database');
const {
    normalizePhoneNumber,
    encodeWhatsAppMessage,
    decodeWhatsAppMessage,
    buildWhatsAppUrl,
    createTrackedLink,
    recordLinkClick,
    getLinkAnalytics
} = require('../whatsapp_links');

test('WhatsApp Links & Click-to-WhatsApp Suite', async (t) => {
    await db.initDatabase();

    await t.test('Scenario 1: Create a valid WhatsApp link', async () => {
        const link = await createTrackedLink({
            phone: '+91 98765 43210',
            message: 'Hello from CRM link!'
        });

        assert.ok(link.id > 0, 'Link ID should be generated');
        assert.ok(link.slug, 'Link slug should be generated');
        assert.equal(link.normalizedPhone, '919876543210');
        assert.ok(link.encodedUrl.includes('https://wa.me/919876543210?text=Hello'), 'Should have wa.me with encoded text');
    });

    await t.test('Scenario 2: Reject an invalid or incomplete phone number', () => {
        const invalidCases = [
            '',
            '12345', // too short
            'abc12345678', // non-numeric
            '++91-invalid-phone',
            '1234567890123456789' // too long (>15 digits)
        ];

        for (const raw of invalidCases) {
            const { isValid, error } = normalizePhoneNumber(raw);
            assert.equal(isValid, false, `Should reject ${raw}`);
            assert.ok(error, 'Should have informative error message');
        }
    });

    await t.test('Scenario 3: Encode and decode messages containing emojis, Hindi text, and special characters', () => {
        const testMessages = [
            'Special offer! 🚀 20% discount & free trial: https://example.com/deal?id=123',
            'नमस्ते! आपका ऑर्डर तैयार है। धन्यवाद 🙏',
            'Hey & Welcome! "Quote" / Path\\ & Symbols @ # $ % ^ * ( ) _ + = ~'
        ];

        for (const msg of testMessages) {
            const encoded = encodeWhatsAppMessage(msg);
            // Must not contain unencoded raw spaces
            assert.equal(encoded.includes(' '), false, 'Spaces must be percent-encoded');
            
            const decoded = decodeWhatsAppMessage(encoded);
            assert.equal(decoded, msg, 'Decoded message must match original verbatim');
        }
    });

    await t.test('Scenario 4: Verify generated links point to correct WhatsApp destination', () => {
        const urlWithText = buildWhatsAppUrl('919876543210', 'Hi team!');
        assert.equal(urlWithText, 'https://wa.me/919876543210?text=Hi%20team!');

        const urlWithoutText = buildWhatsAppUrl('919876543210', '');
        assert.equal(urlWithoutText, 'https://wa.me/919876543210');

        const urlNullText = buildWhatsAppUrl('919876543210', null);
        assert.equal(urlNullText, 'https://wa.me/919876543210');
    });

    await t.test('Scenario 5: Track a click accurately without falsely recording a conversation or lead', async () => {
        // Initial state
        const initialLeadCount = (await db.get(`SELECT COUNT(*) as count FROM leads`)).count;
        const initialConversationCount = (await db.get(`SELECT COUNT(*) as count FROM activities WHERE type LIKE '%WHATSAPP%'`)).count;

        const tracked = await createTrackedLink({
            phone: '919876543210',
            message: 'Inquiry from Facebook Ad'
        });

        // Simulate 3 clicks from different user-agents
        await recordLinkClick(tracked.slug, { referrer: 'facebook.com', userAgent: 'Mozilla/Chrome', ip: '192.168.1.10' });
        await recordLinkClick(tracked.slug, { referrer: 'google.com', userAgent: 'Safari/iPhone', ip: '192.168.1.11' });
        await recordLinkClick(tracked.slug, { referrer: 'instagram.com', userAgent: 'InstagramApp', ip: '192.168.1.12' });

        const analytics = await getLinkAnalytics(tracked.id);
        assert.equal(analytics.totalClicks, 3, 'Clicks count must be exactly 3');
        assert.equal(analytics.clicks.length, 3, 'Click event records must equal 3');

        // Verify isolation: clicks must NOT create artificial leads or claim a conversation started
        const linkLead = await db.get(`SELECT * FROM leads WHERE notes LIKE ? OR company = ?`, [`%${tracked.slug}%`, tracked.slug]);
        const linkActivity = await db.get(`SELECT * FROM activities WHERE description LIKE ?`, [`%${tracked.slug}%`]);

        assert.equal(linkLead, undefined, 'Click tracking must NOT create unexpected leads');
        assert.equal(linkActivity, undefined, 'Click tracking must NOT claim a conversation occurred');
    });
});
