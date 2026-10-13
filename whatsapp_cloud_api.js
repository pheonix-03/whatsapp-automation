const db = require('./database');
const path = require('path');
const fs = require('fs');

class WhatsAppCloudApiService {
    constructor() {
        this.config = {
            engineType: 'WEB', // 'WEB' or 'CLOUD_API'
            phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
            wabaId: process.env.WHATSAPP_WABA_ID || '',
            accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
            verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'leadsquared_wa_token_secure',
            appSecret: process.env.WHATSAPP_APP_SECRET || '',
            apiVersion: 'v21.0'
        };
        this.isLoaded = false;
    }

    async loadConfig() {
        try {
            await db.run(`
                CREATE TABLE IF NOT EXISTS whatsapp_config (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `);

            const rows = await db.all(`SELECT key, value FROM whatsapp_config`);
            for (const r of rows) {
                if (r.key === 'engine_type') this.config.engineType = r.value;
                if (r.key === 'phone_number_id') this.config.phoneNumberId = r.value;
                if (r.key === 'waba_id') this.config.wabaId = r.value;
                if (r.key === 'access_token') this.config.accessToken = r.value;
                if (r.key === 'verify_token') this.config.verifyToken = r.value;
                if (r.key === 'app_secret') this.config.appSecret = r.value;
                if (r.key === 'api_version') this.config.apiVersion = r.value;
            }
            this.isLoaded = true;
        } catch (e) {
            console.error('[WhatsApp Cloud API] Error loading config:', e.message);
        }
    }

    async updateConfig(newConfig) {
        await this.loadConfig();

        if (newConfig.engineType) this.config.engineType = newConfig.engineType;
        if (newConfig.phoneNumberId !== undefined) this.config.phoneNumberId = newConfig.phoneNumberId.trim();
        if (newConfig.wabaId !== undefined) this.config.wabaId = newConfig.wabaId.trim();
        if (newConfig.accessToken !== undefined) this.config.accessToken = newConfig.accessToken.trim();
        if (newConfig.verifyToken !== undefined) this.config.verifyToken = newConfig.verifyToken.trim();
        if (newConfig.appSecret !== undefined) this.config.appSecret = newConfig.appSecret.trim();
        if (newConfig.apiVersion !== undefined) this.config.apiVersion = newConfig.apiVersion.trim();

        const entries = [
            ['engine_type', this.config.engineType],
            ['phone_number_id', this.config.phoneNumberId],
            ['waba_id', this.config.wabaId],
            ['access_token', this.config.accessToken],
            ['verify_token', this.config.verifyToken],
            ['app_secret', this.config.appSecret],
            ['api_version', this.config.apiVersion]
        ];

        for (const [k, v] of entries) {
            await db.run(`
                INSERT INTO whatsapp_config (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `, [k, v || '']);
        }

        return this.getPublicConfig();
    }

    getPublicConfig() {
        return {
            engineType: this.config.engineType,
            phoneNumberId: this.config.phoneNumberId,
            wabaId: this.config.wabaId,
            hasAccessToken: !!this.config.accessToken,
            maskedToken: this.config.accessToken ? `••••••••${this.config.accessToken.slice(-6)}` : '',
            verifyToken: this.config.verifyToken,
            hasAppSecret: !!this.config.appSecret,
            apiVersion: this.config.apiVersion,
            isConfigured: !!(this.config.phoneNumberId && this.config.accessToken)
        };
    }

    isCloudApiActive() {
        return this.config.engineType === 'CLOUD_API';
    }

    async testConnection() {
        await this.loadConfig();
        if (!this.config.phoneNumberId || !this.config.accessToken) {
            throw new Error('Phone Number ID and Access Token are required to test WhatsApp Cloud API.');
        }

        const url = `https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.config.accessToken}`
            }
        });

        const data = await response.json();
        if (!response.ok) {
            const errorMsg = data.error?.message || `HTTP ${response.status}: Failed to connect to WhatsApp Cloud API`;
            throw new Error(errorMsg);
        }

        return {
            success: true,
            displayPhoneNumber: data.display_phone_number,
            verifiedName: data.verified_name,
            qualityRating: data.quality_rating,
            codeVerificationStatus: data.code_verification_status
        };
    }

    async sendMessage({ to, message, mediaPath = null, templateName = null, templateLang = 'en_US' }) {
        await this.loadConfig();
        if (!this.config.phoneNumberId || !this.config.accessToken) {
            throw new Error('WhatsApp Cloud API is not configured. Please provide Phone Number ID and Access Token.');
        }

        // Normalize phone number to international format without +
        const cleanTo = to.toString().replace(/\D/g, '');

        const url = `https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`;
        let payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanTo
        };

        if (templateName) {
            // Official Template Message
            payload.type = 'template';
            payload.template = {
                name: templateName,
                language: { code: templateLang }
            };
        } else if (mediaPath && fs.existsSync(mediaPath)) {
            // Media Message
            const isImg = /\.(jpg|jpeg|png|webp|gif)$/i.test(mediaPath);
            const isVid = /\.(mp4|mov|avi|m4v|3gp)$/i.test(mediaPath);
            const mediaType = isImg ? 'image' : (isVid ? 'video' : 'document');

            // Convert to public or local URL if possible
            const filename = path.basename(mediaPath);
            const mediaUrl = `http://localhost:3000/uploads/media/${filename}`;

            payload.type = mediaType;
            payload[mediaType] = {
                link: mediaUrl,
                caption: message || undefined
            };
        } else {
            // Standard Text Message
            payload.type = 'text';
            payload.text = {
                preview_url: false,
                body: message
            };
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (!response.ok) {
            const errMsg = data.error?.message || `WhatsApp Cloud API Error (${response.status})`;
            throw new Error(errMsg);
        }

        const messageId = data.messages && data.messages[0] ? data.messages[0].id : null;
        return {
            success: true,
            providerMessageId: messageId,
            phone: cleanTo,
            data
        };
    }
}

const cloudApi = new WhatsAppCloudApiService();
cloudApi.loadConfig().catch(() => {});

module.exports = cloudApi;
