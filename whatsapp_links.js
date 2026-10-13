const crypto = require('crypto');
const db = require('./database');

/**
 * Normalizes phone numbers to standard international format (digits only, no + or spaces).
 * Validates length and characters according to E.164 guidelines.
 */
function normalizePhoneNumber(rawPhone, defaultCountryCode = '91') {
    if (!rawPhone || typeof rawPhone !== 'string' && typeof rawPhone !== 'number') {
        return { isValid: false, normalized: null, error: 'Phone number is required.' };
    }

    let cleaned = rawPhone.toString().trim();

    // Remove any leading '+'
    if (cleaned.startsWith('+')) {
        cleaned = cleaned.substring(1);
    }

    // Strip spaces, dashes, brackets, dots
    cleaned = cleaned.replace(/[\s\-\(\)\.]/g, '');

    // Check if remaining string contains only digits
    if (!/^\d+$/.test(cleaned)) {
        return { isValid: false, normalized: null, error: 'Phone number contains invalid non-numeric characters.' };
    }

    // Standard 10-digit number handling (e.g. India / US)
    if (cleaned.length === 10) {
        cleaned = defaultCountryCode + cleaned;
    }

    // E.164 allows 7 to 15 digits
    if (cleaned.length < 8 || cleaned.length > 15) {
        return { isValid: false, normalized: null, error: `Invalid phone length: ${cleaned.length} digits. Must be 8-15 digits.` };
    }

    return { isValid: true, normalized: cleaned, error: null };
}

/**
 * URL-encodes WhatsApp message text, safely preserving UTF-8 emojis and multi-language characters.
 */
function encodeWhatsAppMessage(message) {
    if (!message || typeof message !== 'string') return '';
    return encodeURIComponent(message.trim());
}

/**
 * Decodes URL-encoded WhatsApp message.
 */
function decodeWhatsAppMessage(encoded) {
    if (!encoded || typeof encoded !== 'string') return '';
    try {
        return decodeURIComponent(encoded);
    } catch {
        return encoded;
    }
}

/**
 * Builds canonical wa.me link.
 */
function buildWhatsAppUrl(normalizedPhone, message = '') {
    const baseUrl = `https://wa.me/${normalizedPhone}`;
    if (!message || message.trim() === '') {
        return baseUrl;
    }
    const encoded = encodeWhatsAppMessage(message);
    return `${baseUrl}?text=${encoded}`;
}

/**
 * Generates a unique 6-character alphanumeric slug.
 */
function generateSlug(length = 6) {
    return crypto.randomBytes(length).toString('base64url').substring(0, length);
}

/**
 * Creates and saves a tracked Click-to-WhatsApp link.
 */
async function createTrackedLink({ phone, message = '', campaignId = null, leadId = null, customSlug = null }) {
    const { isValid, normalized, error } = normalizePhoneNumber(phone);
    if (!isValid) {
        throw new Error(error);
    }

    let slug = customSlug ? customSlug.trim() : generateSlug();
    const encodedUrl = buildWhatsAppUrl(normalized, message);

    try {
        const result = await db.run(`
            INSERT INTO whatsapp_links (slug, phone, normalized_phone, message, encoded_url, campaign_id, lead_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [slug, phone.toString().trim(), normalized, message, encodedUrl, campaignId || null, leadId || null]);

        return {
            id: result.lastID,
            slug,
            normalizedPhone: normalized,
            encodedUrl,
            shortUrl: `/l/${slug}`
        };
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint')) {
            // Slug collision - regenerate
            return createTrackedLink({ phone, message, campaignId, leadId, customSlug: null });
        }
        throw err;
    }
}

/**
 * Records a link click event.
 * Note: Link click is tracked strictly as a click, NOT as an inbound conversation or lead creation.
 */
async function recordLinkClick(slug, { referrer = '', userAgent = '', ip = '' } = {}) {
    const link = await db.get(`SELECT * FROM whatsapp_links WHERE slug = ?`, [slug]);
    if (!link) {
        return { found: false, destinationUrl: null };
    }

    const ipHash = ip ? crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16) : '';

    await db.run(`
        INSERT INTO whatsapp_link_clicks (link_id, referrer, user_agent, ip_hash)
        VALUES (?, ?, ?, ?)
    `, [link.id, referrer || '', userAgent || '', ipHash]);

    await db.run(`
        UPDATE whatsapp_links SET clicks_count = clicks_count + 1 WHERE id = ?
    `, [link.id]);

    return {
        found: true,
        destinationUrl: link.encoded_url,
        link
    };
}

/**
 * Fetches link analytics.
 */
async function getLinkAnalytics(linkId) {
    const link = await db.get(`SELECT * FROM whatsapp_links WHERE id = ?`, [linkId]);
    if (!link) return null;

    const clicks = await db.all(`
        SELECT * FROM whatsapp_link_clicks WHERE link_id = ? ORDER BY clicked_at DESC LIMIT 100
    `, [linkId]);

    return {
        link,
        totalClicks: link.clicks_count,
        clicks
    };
}

module.exports = {
    normalizePhoneNumber,
    encodeWhatsAppMessage,
    decodeWhatsAppMessage,
    buildWhatsAppUrl,
    createTrackedLink,
    recordLinkClick,
    getLinkAnalytics
};
