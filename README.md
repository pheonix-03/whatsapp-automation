# LeadSquared Clone CRM with 100% Free WhatsApp Automation Hub

A self-hosted, full-featured **LeadSquared CRM alternative** with built-in **WhatsApp Web automation**, built with **Node.js, Express, SQLite, and whatsapp-web.js**.

---

## 🚀 Quick Start

The server is already running!
1. Open your browser and go to: **[http://localhost:3000](http://localhost:3000)**
2. In the future, you can start the application anytime by:
   - Double-clicking **`start.bat`**
   - Or running: `npm start` (or `node server.js`) in this folder.

---

## 📱 How to Connect WhatsApp (Scan QR Once)

1. Open **[http://localhost:3000](http://localhost:3000)**.
2. In the left sidebar or top right status pill, click **"Manage Device"** or go to the **WhatsApp Engine** tab.
3. Click **"Scan QR / Link Device"**.
4. Open WhatsApp on your phone:
   - Tap **Settings** (or 3 dots on Android) > **Linked Devices** > **Link a Device**.
   - Point your camera at the QR code displayed in the dashboard.
5. Once scanned, your session is saved locally in `.wwebjs_auth`. You will **never have to scan again** unless you log out!

---

## 🌟 Key Features

### 1. Lead Management & Sales Pipeline (LeadSquared Style)
- **Pipeline Stages**: *New*, *Contacted*, *Qualified*, *Proposal Sent*, *Closed Won*, *Lost*.
- **Lead Scoring & Priority**: Track score (0–100) and priority (High, Medium, Low).
- **Lead 360° Profile Drawer**:
  - Direct 1-click WhatsApp chat right from the lead drawer.
  - Full timeline of all interactions (calls, notes, stage transitions, message history).
  - Edit lead details, notes, and qualification stages.
- **CSV Import & Export**: Import your existing leads from CSV/Excel in 1 click or export your leads.

### 2. WhatsApp Web Automation Engine
- **Direct 1-Click Messaging**: Send instant WhatsApp messages to any lead.
- **Two-way Sync**: Incoming WhatsApp messages from leads automatically show in their activity timeline and increase their engagement score!
- **Anti-Ban Throttling**: Message queue with randomized 4–8 second human pacing to protect your WhatsApp account.

### 3. Broadcast Campaigns
- Broadcast personalized messages to all leads or leads in a specific stage (e.g. *Stage: Qualified*).
- Personalization tags: `{{first_name}}`, `{{company}}`, `{{phone}}`.
- Real-time campaign tracking: sent count, failed count, progress.

### 4. Workflow Automations
- **Auto Welcome Message**: Automatically sends a personalized WhatsApp welcome message whenever a new lead is added (via web form, manual entry, or API).
- **Stage Change Triggers**: Automatically triggers WhatsApp follow-ups when a lead moves to a specific stage (e.g., moved to *Qualified*).

### 5. Reusable Message Templates
- Preloaded with high-converting sales templates (Welcome Greeting, Follow-Up, Demo Invitation, Limited-time Offer).
- Create, edit, and categorize custom templates.

---

## 🔒 100% Free & Private
- All lead data is stored in your local SQLite database (`leadsquared.db`).
- WhatsApp messages go directly through your linked phone session — zero third-party API fees, zero Meta conversation charges!
"# whatsapp-automation" 
