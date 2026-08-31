/**
 * GoBaku WhatsApp Auto-Reply Bot
 * ---------------------------------
 * Receives incoming WhatsApp messages via Blueticks webhook and
 * automatically replies based on the rules built for this business.
 *
 * HOW IT WORKS
 * 1. Blueticks calls POST /webhook whenever a new message arrives.
 * 2. This server inspects the message and the chat's conversation state.
 * 3. It sends the right reply back through the Blueticks API.
 *
 * DEPLOY: works on Railway, Render, Fly.io, or any Node host.
 * ENV VARS REQUIRED:
 *   BLUETICKS_API_KEY   - your Blueticks API key
 *   PORT                - (optional) defaults to 3000
 */

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const BLUETICKS_API_BASE = "https://api.blueticks.co/v1";
const API_KEY = process.env.BLUETICKS_API_KEY;

// ---------------------------------------------------------------------------
// In-memory state: tracks what stage each chat is in, so we don't repeat
// ourselves or misinterpret a reply out of context.
// In production, swap this Map for a real database (e.g. SQLite, Postgres,
// Redis) so state survives restarts.
// ---------------------------------------------------------------------------
const chatState = new Map();
// chatState[chatId] = {
//   sentMenu: bool,
//   sentPackageNumber: number|null,
//   awaitingSatisfaction: bool,
// }

function getState(chatId) {
  if (!chatState.has(chatId)) {
    chatState.set(chatId, {
      sentMenu: false,
      sentPackageNumber: null,
      awaitingSatisfaction: false,
      awaitingTravelInfo: false,
      travelInfo: { travelers: null, city: null, date: null },
    });
  }
  return chatState.get(chatId);
}

function travelInfoComplete(state) {
  return !!(state.travelInfo.travelers && state.travelInfo.city && state.travelInfo.date);
}

function nextMissingTravelInfoQuestion(state) {
  if (!state.travelInfo.travelers) return "How many travelers will there be?";
  if (!state.travelInfo.city) return "Which city will you be traveling from?";
  if (!state.travelInfo.date) return "What's your preferred travel date or month?";
  return null;
}

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------
const PACKAGE_MENU = `Thank you for your interest! Here are our available Baku packages — kindly let us know which one you'd like:

1️⃣ Basic – PKR 39,500/person (3N/4D) (3-star hotel, breakfast, airport transfer & guide included) (flight, visa, lunch & dinner not included)
2️⃣ 4N/5D Package
3️⃣ 5N/6D Package
4️⃣ 6N/7D Package
5️⃣ 7N/8D Package
6️⃣ 8N/9D Package
7️⃣ 9N/10D Package

Please confirm which package and number of travelers, and we'll send the full itinerary and pricing right away!`;

const TRAVEL_INFO_QUESTION = `A few quick questions so I can share the exact total:
Which city will you be traveling from?
How many travelers?
Preferred travel date/month?

Please note: flights and visa are not included in the packages, but we can arrange both for you if you'd like.`;

const SATISFACTION_QUESTION = `Are you satisfied with this package?`;

// Package number -> Dropbox direct-download PDF link (dl=1 format).
// These are the COMPRESSED versions (~1MB each vs ~7MB originals) for
// fast, reliable delivery. Replace if the files move.
const PACKAGE_PDFS = {
  1: "https://www.dropbox.com/scl/fi/m2xsuy1z5kkcv9i2zdjir/3_Night__4_Days_ITINERARY.pdf?rlkey=tlxmcs78l1rg8ohif2nituuoe&st=8rtru2uv&dl=1",
  2: "https://www.dropbox.com/scl/fi/olxuuee3wi45mwtl17x27/4_Night__5_Days_ITINERARY.pdf?rlkey=tvhjunfodj043952ldyoy94b2&st=ptt40v7k&dl=1",
  3: "https://www.dropbox.com/scl/fi/3y1bcg1mutgk9952rnj7j/5_Night__6_Days_ITINERARY.pdf?rlkey=do4mtwom4d4vsa6rcvq79ghmt&st=zyqvlxzz&dl=1",
  4: "https://www.dropbox.com/scl/fi/gg2m3sumctws0lmt3lhrr/6_Night__7_Days_ITINERARY.pdf?rlkey=fsto02lp5dmnw9ulq35xhwnbs&st=6ekgpmgt&dl=1",
  5: "https://www.dropbox.com/scl/fi/wr8pb5gwt1nl54kmrqn5o/7_Night__8_Days_ITINERARY.pdf?rlkey=q3j5ngb81ezadzfylvmji650g&st=aqxil3hb&dl=1",
  6: "https://www.dropbox.com/scl/fi/ai17z2tj6pm508leevaes/_8_Night__9_Days_ITINERARY.pdf?rlkey=lgro9o23e0qf2mhucj7cl8e6k&st=u34y40vz&dl=1",
  7: "https://www.dropbox.com/scl/fi/txq2brb5gb7rt3esg2po2/_9_Night__10_Days_ITINERARY.pdf?rlkey=wq1tzclr8ln34nkrrybd0ktd8&st=t8ii0gxx&dl=1",
};

// ---------------------------------------------------------------------------
// Rule matching helpers
// ---------------------------------------------------------------------------

/** Extracts a clear package-number choice (1-7) from a message, or null. */
function extractPackageNumber(text) {
  if (!text) return null;
  // Strip invisible/zero-width/control characters WhatsApp sometimes adds
  // (these silently broke exact-match regex before this fix).
  const clean = text.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF\u00A0]/g, "").trim();

  // Matches "1", "package 1", "pkg no. 1", "1️⃣", "number 1", etc.
  const patterns = [
    /^([1-7])$/,                              // just a bare digit
    /package\s*(?:no\.?|number)?\s*([1-7])\b/i,
    /\bno\.?\s*([1-7])\b/i,
  ];
  for (const re of patterns) {
    const m = clean.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** True if the message is a visa/ticket/inclusions style question. */
function isVisaOrTicketQuestion(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const keywords = [
    "visa", "ticket", "tickets", "flight", "flights",
    "include everything", "including", "not included",
    "air ticket", "airfare",
  ];
  return keywords.some((k) => t.includes(k));
}

/** True if the message is a generic pricing question. */
function isPricingQuestion(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const keywords = ["price", "cost", "charges", "total", "how much", "pkr"];
  return keywords.some((k) => t.includes(k));
}

/** True if the message looks like a fresh inquiry (promo reply). */
function isFreshInquiry(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("more info") ||
    t.includes("hello") ||
    t.includes("baku") ||
    t.includes("detail") ||
    t.includes("package")
  );
}

/** True if the message is an affirmative ("yes", "haan", etc.) */
function isAffirmative(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return ["yes", "yeah", "yep", "haan", "ji", "ok", "okay", "sure"].includes(t);
}

// ---------------------------------------------------------------------------
// Blueticks API helpers
//
// IMPORTANT: The exact field names below (e.g. "text" vs "message", the
// mark-read endpoint shape) are a best-effort guess based on available
// documentation, which had some inconsistencies across sources. Before
// relying on this in production:
//   1. Check https://dev.blueticks.co/docs for the current, authoritative
//      request/response shapes.
//   2. Send one test message manually and check the Railway deploy logs
//      to confirm the request succeeded (look for a 200, not a 400).
//   3. Adjust the JSON.stringify(...) bodies below if the API rejects them.
// ---------------------------------------------------------------------------

async function sendText(chatId, text) {
  const res = await fetch(`${BLUETICKS_API_BASE}/scheduled-messages/${chatId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ type: "text", text }),
  });
  const body = await res.text();
  console.log(`sendText -> status ${res.status}: ${body}`);
  return res;
}

async function sendMedia(chatId, mediaUrl) {
  const res = await fetch(`${BLUETICKS_API_BASE}/scheduled-messages/${chatId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ type: "media", media_url: mediaUrl }),
  });
  const body = await res.text();
  console.log(`sendMedia -> status ${res.status}: ${body}`);
  return res;
}

async function markRead(chatId) {
  const res = await fetch(`${BLUETICKS_API_BASE}/chats/${chatId}/mark_read`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({}),
  });
  const body = await res.text();
  console.log(`markRead -> status ${res.status}: ${body}`);
  return res;
}

// ---------------------------------------------------------------------------
// Core decision logic — mirrors the rules built in our chat sessions
// ---------------------------------------------------------------------------

async function handleIncomingMessage(chatId, messageType, text) {
  const state = getState(chatId);

  // Rule: voice message after the promo -> send package list
  if (messageType === "ptt" || messageType === "audio") {
    if (!state.sentMenu) {
      await sendText(chatId, PACKAGE_MENU);
      state.sentMenu = true;
    }
    await markRead(chatId);
    return;
  }

  // Only plain text below this point
  if (messageType !== "chat" && messageType !== "text") {
    // Unknown / unreadable / ciphertext / image etc. — if they've never
    // gotten the menu, send it as a safe default. Otherwise leave it for
    // a human to look at.
    if (!state.sentMenu) {
      await sendText(chatId, PACKAGE_MENU);
      state.sentMenu = true;
    }
    await markRead(chatId);
    return;
  }

  // 1) Client picked a package number (only if none picked yet in this convo)
  const pkgNum = extractPackageNumber(text);
  console.log(`extractPackageNumber("${text}") -> ${pkgNum}, alreadyPicked=${state.sentPackageNumber}`);
  if (pkgNum && PACKAGE_PDFS[pkgNum] && !state.sentPackageNumber) {
    await sendMedia(chatId, PACKAGE_PDFS[pkgNum]);
    await sendText(chatId, SATISFACTION_QUESTION);
    state.sentPackageNumber = pkgNum;
    state.awaitingSatisfaction = true;
    await markRead(chatId);
    return;
  }

  // 2) Client responding to the satisfaction check
  if (state.awaitingSatisfaction) {
    if (isAffirmative(text)) {
      state.awaitingSatisfaction = false;
      state.awaitingTravelInfo = true;
      await sendText(chatId, TRAVEL_INFO_QUESTION);
      await markRead(chatId);
      return;
    }
    // If not a clear yes, fall through — they may be answering something else
  }

  // 3) Currently collecting travel info (city/travelers/date) — do NOT stop
  // early. Try to extract whichever piece this message answers, then ask
  // for whatever's still missing instead of ending the conversation.
  if (state.awaitingTravelInfo) {
    const travelerMatch = text.match(/\b(\d+)\s*(travel?ers?|people|persons?|adults?|pax)?\b/i);
    if (travelerMatch && !state.travelInfo.travelers) {
      state.travelInfo.travelers = travelerMatch[1];
    } else if (!state.travelInfo.city && /^[a-zA-Z\s]{2,30}$/.test(text.trim()) && !isVisaOrTicketQuestion(text)) {
      // Heuristic: a short alphabetic reply is likely a city name
      state.travelInfo.city = text.trim();
    } else if (!state.travelInfo.date && /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}\/\d{1,2}|\d{4})\b/i.test(text)) {
      state.travelInfo.date = text.trim();
    }

    const nextQuestion = nextMissingTravelInfoQuestion(state);
    if (nextQuestion) {
      await sendText(chatId, nextQuestion);
      await markRead(chatId);
      return;
    }

    // All three collected — confirm and hand off, only now.
    state.awaitingTravelInfo = false;
    const { travelers, city, date } = state.travelInfo;
    await sendText(
      chatId,
      `Perfect — ${travelers} traveler(s) from ${city}, traveling around ${date}. Our team will follow up shortly with the full itinerary and pricing. Please note flights and visa aren't included, but we can arrange both if you'd like.`
    );
    await markRead(chatId);
    return;
  }

  // 4) Visa / ticket / inclusions / pricing question -> start collecting travel info
  if (isVisaOrTicketQuestion(text) || isPricingQuestion(text)) {
    state.awaitingTravelInfo = true;
    await sendText(chatId, TRAVEL_INFO_QUESTION);
    await markRead(chatId);
    return;
  }

  // 5) Fresh inquiry / hasn't gotten the menu yet -> send it
  if (!state.sentMenu || isFreshInquiry(text)) {
    await sendText(chatId, PACKAGE_MENU);
    state.sentMenu = true;
    await markRead(chatId);
    return;
  }

  // 6) Nothing matched confidently — leave unread for a human to handle.
  // (Do NOT mark read, so it stays visible as needing attention.)
  console.log(`[FLAG FOR HUMAN] chat=${chatId} text="${text}"`);
}

// ---------------------------------------------------------------------------
// Webhook endpoint
// ---------------------------------------------------------------------------

app.post("/webhook", async (req, res) => {
  try {
    const event = req.body;

    // Blueticks' actual event name (confirmed via API error message):
    // new_message_received_webhook — NOT "message.received".
    // The exact payload field names inside `data`/`event` are NOT publicly
    // documented, so this parsing is a best-effort guess. If the bot doesn't
    // respond after deployment, log `JSON.stringify(event)` here, check the
    // Railway deploy logs for the real shape of one incoming request, and
    // adjust the destructuring below to match.
    console.log("Webhook received:", JSON.stringify(event));

    if (event.type !== "new_message_received_webhook") {
      return res.sendStatus(200); // ignore other event types
    }

    const payload = event.data || {};
    const chatId = payload.chatId;
    const type = payload.type || "chat";
    const text = payload.body;
    const fromMe = payload.fromMe;

    if (!chatId || fromMe) {
      return res.sendStatus(200); // ignore our own outgoing messages
    }

    await handleIncomingMessage(chatId, type, text);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// Health check endpoint (useful for hosting platforms)
app.get("/", (req, res) => res.send("GoBaku bot is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot listening on port ${PORT}`));
