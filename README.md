# 🌐 EventsOrg MCP: Autonomous AI Event Manager

An open-source **Model Context Protocol (MCP)** server and background autonomous agent designed to run the logistics of live events. 

EventsOrg MCP gives LLMs (like Claude and Gemini) the "hands" to read live event data, reassign volunteers, cancel missing vendors, and communicate with staff via physical SMS messages.

> **Note:** This repository is a framework. It is designed so that **any event organizer can deploy their own instance** of this code, attach their own API keys, and manage their own isolated event.

---

## ✨ Features

- **MCP Protocol Native:** Exposes over 20+ event management tools (e.g., `reassign_volunteer`, `get_vendor_status`) to any standard AI client.
- **Twilio SMS Orchestration:** The AI can text volunteers physical SMS messages. Inbound SMS replies are automatically parsed and routed back into the database.
- **Autonomous Agent Loop:** Includes a standalone Gemini-powered agent (`agent.ts`) that runs 24/7, actively monitoring the event and resolving issues before a human even notices.
- **Google Sheets Sync:** Automatically pushes real-time database state to a Google Sheets dashboard for human coordinators to view.
- **Zero-Config Local Webhooks:** Uses Cloudflare Tunnels (`untun`) to automatically route live Twilio SMS back to your `localhost` during development.

---

## 🏗 Architecture & Use Cases

This codebase supports three entirely different ways to interact with the AI:

### 1. Local Desktop Plugin (`stdio`)
Perfect for solo event organizers or local development. By connecting the code to **Claude Desktop** or **Cursor**, the AI talks directly to the local SQLite database via standard terminal input/output (`stdio`).
* *Requires: Your laptop to stay open and running.*

### 2. Public API for AI (`HTTP / SSE`)
By starting the server with the `--transport http` flag, you turn the local server into a globally accessible web API. Other developers, LangChain apps, or AI IDEs can connect to your event remotely using Server-Sent Events (SSE).
* *Requires: Deployment to a cloud host like Railway, AWS, or Render.*

### 3. The Autonomous Virtual Coordinator
You don't even need a chat window. By running the included `agent.ts` script, a Gemini-powered worker wakes up every 5 minutes, checks the database for anomalies (missing vendors, safety incidents, weather alerts), fixes them, and texts the staff—completely autonomously.

---

## 🚀 How to Deploy Your Own Event

Because this system uses a local SQLite database (`grid.db`), **one deployment equals one event.** If multiple organizers want to run different events, they must deploy their own separate instances of this code.

### Prerequisites
You will need API keys for:
- [Twilio](https://www.twilio.com/) (Account SID, Auth Token, Phone Number)
- [Google Cloud](https://cloud.google.com/) (Service Account JSON with Sheets API enabled)
- [Google Gemini](https://aistudio.google.com/) (For the autonomous agent)

### Environment Variables
Since there is no `.env.example` in the codebase, here are all the environment variables you need to define in your `.env` file (or Railway dashboard) before starting the server:

```env
# AI Models
GOOGLE_API_KEY=your_gemini_api_key

# Twilio SMS Engine
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_PHONE_NUMBER=+1234567890

# External Integrations
OPENWEATHER_API_KEY=your_openweather_key
GOOGLE_MAPS_API_KEY=your_maps_key

# Escalation Emails
COORDINATOR_EMAIL=your_email@gmail.com
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password

# Webhook Config
PUBLIC_URL=eventsorg-mcp-production.up.railway.app # Set this when deployed publicly
WEBHOOK_PORT=3000

# Google Sheets Sync
GOOGLE_SHEET_ID=your_google_sheet_id
GOOGLE_SERVICE_ACCOUNT_JSON='{ "type": "service_account", ... }'
```

### Local Setup
1. Clone the repository and run `npm install`.
2. Copy `.env.example` to `.env` and fill in your keys.
3. Add the server to your `claude_desktop_config.json`:
   ```json
   "grid-event-manager": {
     "command": "npx",
     "args": ["tsx", "/absolute/path/to/EventsOrg-MCP/src/index.ts"]
   }
   ```
4. Open Claude Desktop and start managing your event!

### Cloud Deployment (Railway)
If you want to host this publicly so an AI can manage it 24/7 in the cloud:
1. Push this code to your own GitHub repo.
2. Go to **Railway.app**, create a new project, and deploy from GitHub.
3. Paste your `.env` variables into the Railway dashboard.
4. Generate a public URL in Railway and add it as `PUBLIC_URL` in your variables.
5. In your Twilio console, point your phone number's webhook to `https://<YOUR-RAILWAY-URL>/webhook/sms`.

*(Note: The `npm start` command will automatically seed the database with fake "sample event" data. If you are running a real event, remove `tsx src/seed.ts` from the `start` script in `package.json`!)*

---

## 🧪 Testing with the Live "Sample Event"

If you just want to test how the MCP protocol works without hosting a real event, I have deployed a public test instance of this server. Every time this test server boots, it completely wipes the database and fills it with a chaotic, half-broken music festival (vendors are 45 minutes late, zones are short-staffed). 

You can build or connect your own MCP clients (like LangChain, custom apps, or AI code editors) to test it right now!

**Live Test SSE Endpoint:** `https://eventsorg-mcp-production.up.railway.app/sse`

Connect your AI to this URL and ask it: *"What is the status of my event?"* Watch as it identifies the issues and fires off physical text messages to try and save the festival!

---

## 🛠 Available MCP Tools

This MCP server exposes over 20+ tools to give your AI full operational control over the event. Here are the main highlights:

- 📱 **Twilio SMS Orchestration:** (`send_sms`, `get_sms_history`) Allows the AI to text staff directly. Inbound replies are automatically logged to the database via webhook.
- 📊 **Google Sheets Dashboard:** (`sync_to_sheets`) Pushes the real-time state of the database to a remote Google Sheet for human coordinators.
- 🗺️ **Maps & Weather:** (`get_directions`, `get_weather`) Provides the AI with live contextual data, such as walking times for reassigning volunteers or rain alerts for outdoor zones.
- 🔍 **Core Operations:** (`get_event_summary`, `reassign_volunteer`, `cancel_vendor_slot`, `escalate_to_coordinator`, `move_zone_indoors`)

*(Note: This is just a highlight! The server includes many more granular tools for managing incidents, checking in vendors, and querying exact database state.)*
