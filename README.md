# GoBaku WhatsApp Auto-Reply Bot

This bot automatically replies to WhatsApp messages using the rules built for
GoBaku Travel: sending the package menu, handling package-number picks (with
PDF + satisfaction follow-up), and answering visa/pricing questions.

## What it does

| Client sends | Bot replies |
|---|---|
| "Hello, more info", or hasn't gotten the menu yet | Package list (all 7 options) |
| A package number (1-7) | The matching itinerary PDF, then "Are you satisfied with this package?" |
| "Yes" (after the satisfaction question) | Asks for city / travelers / travel date |
| Anything about visa, tickets, or "what's included" | Same city/travelers/date question + offer to arrange visa & flights |
| A voice message | Package list (can't transcribe audio, so defaults to the menu) |
| Anything else unclear | Left alone (marked for a human to check) |

## Setup

### 1. Get your Blueticks API key
Log into your Blueticks dashboard and find your API key under account/API settings.

### 2. Install dependencies
```bash
npm install
```

### 2b. Run the tests (optional but recommended)
```bash
npm test
```
Checks the message-classification logic (package number extraction, visa/pricing
detection, etc.) without needing a live Blueticks connection. Runs automatically
on every push/PR via GitHub Actions too.

### 3. Set environment variables
Create a `.env` file or set these in your hosting platform's dashboard:
```
BLUETICKS_API_KEY=your_api_key_here
PORT=3000
```

### 4. Run locally to test
```bash
npm start
```

### 5. Deploy to a free hosting service
Pick one:
- **Railway** (railway.app) — easiest, connects directly to a GitHub repo
- **Render** (render.com) — free tier, similar setup
- **Fly.io** (fly.io) — good free tier, needs their CLI

All three: push this folder to a GitHub repo, connect it, set the
`BLUETICKS_API_KEY` environment variable in their dashboard, and deploy.
You'll get a public URL like `https://your-bot.up.railway.app`.

### 6. Register the webhook with Blueticks
Once deployed, tell Blueticks to send incoming messages to your bot's URL.
This can be done via the Blueticks API (ask Claude to run this for you, or
call it yourself):

```
POST https://api.blueticks.co/v1/webhooks
{
  "url": "https://your-bot.up.railway.app/webhook",
  "events": ["message.received"]
}
```

### 7. Done
From this point on, the bot replies automatically and instantly, 24/7 — no
manual chat session needed.

## Important notes

- **Verify the webhook payload shape.** The code assumes Blueticks sends
  `{ event: "message.received", data: { chatId, type, text, fromMe } }` —
  check Blueticks' actual webhook documentation and adjust the parsing in
  `handleIncomingMessage`'s caller if the field names differ.
- **State is in-memory.** If the bot restarts, it forgets which chats already
  got the menu. For production use, swap the `Map` in `index.js` for a real
  database (SQLite, Postgres, or Redis) so state survives restarts.
- **PDF links.** The `PACKAGE_PDFS` links are Dropbox direct-download URLs.
  If you replace or move the files, update the links in `index.js`.
- **Anything the bot doesn't confidently understand is left alone** (not
  marked as read) so a human can review it — the bot intentionally does not
  guess on ambiguous messages like specific pricing negotiations or
  complaints.
