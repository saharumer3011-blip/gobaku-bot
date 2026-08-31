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
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const BLUETICKS_API_BASE = "https://api.blueticks.co/v1";
const API_KEY = process.env.BLUETICKS_API_KEY;

// ---------------------------------------------------------------------------
// Persistence: chatState and seenEventIds live in memory for speed, but are
// mirrored to a JSON file so conversations survive redeploys/restarts.
//
// IMPORTANT: this only actually survives restarts if STATE_DIR points at a
// Railway VOLUME (Settings -> Volumes -> mount at e.g. /data), not the
// default container filesystem, which is wiped on every deploy just like
// the in-memory Map was. Set STATE_DIR=/data as an env var once the volume
// is attached. Without a volume, this still helps with in-process restarts
// (e.g. a crash) but not with deploys.
// ---------------------------------------------------------------------------
const STATE_DIR = process.env.STATE_DIR || "/data";
const STATE_FILE = path.join(STATE_DIR, "bot-state.json");

// In-memory state: tracks what stage each chat is in, so we don't repeat
// ourselves or misinterpret a reply out of context. Persisted to STATE_FILE.
const chatState = new Map();
// chatState[chatId] = {
//   sentMenu: bool,
//   sentPackageNumber: number|null,
//   awaitingSatisfaction: bool,
// }

// Tracks webhook event IDs already processed, to avoid double-replying if
// Blueticks (or a network hiccup) delivers the same event more than once.
const seenEventIds = new Set();

function loadPersistedState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.log(`No persisted state file found at ${STATE_FILE} (starting fresh)`);
      return;
    }
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.chatState) {
      for (const [chatId, state] of Object.entries(parsed.chatState)) {
        chatState.set(chatId, state);
      }
    }
    if (Array.isArray(parsed.seenEventIds)) {
      for (const id of parsed.seenEventIds) seenEventIds.add(id);
    }
    console.log(`Loaded persisted state for ${chatState.size} chat(s) from ${STATE_FILE}`);
  } catch (err) {
    console.error("Failed to load persisted state (starting fresh):", err);
  }
}

// Debounced so a burst of state changes doesn't hit disk repeatedly.
let saveScheduled = false;
function persistState() {
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(() => {
    saveScheduled = false;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const data = {
        chatState: Object.fromEntries(chatState),
        seenEventIds: Array.from(seenEventIds),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(data));
    } catch (err) {
      console.error("Failed to persist state:", err);
    }
  });
}


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

  // Matches the package's own duration label, e.g. "9N/10D", "9n 10d",
  // "9 nights 10 days" -> package 7 (since package i = (i+2)N / (i+3)D).
  const durationMatch = clean.match(
    /(\d{1,2})\s*n(?:ights?)?\s*[,/]?\s*(\d{1,2})\s*d(?:ays?)?/i
  );
  if (durationMatch) {
    const nights = parseInt(durationMatch[1], 10);
    const days = parseInt(durationMatch[2], 10);
    const pkgNum = nights - 2;
    if (pkgNum >= 1 && pkgNum <= 7 && days === nights + 1) {
      return pkgNum;
    }
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

/**
 * True if the message is a short conversational reply (e.g. "yes please",
 * "sounds good", "sure thing") rather than a fresh inquiry. Used to stop the
 * menu-resend fallback from firing on what is clearly a reply to something,
 * not a new conversation opener -- this matters most as a safety net if
 * `sentMenu` is ever wrong (e.g. state was lost), since blasting the full
 * package list back at someone mid-conversation reads as broken/confusing.
 */
function isShortConversationalReply(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  if (t.split(/\s+/).length > 4) return false; // too long to be a quick reply
  return /^(yes|yeah|yep|yup|haan|ji|ok(ay)?|sure|please|alright|thanks|thank\s*you|noted|got\s*it|great|perfect|cool)\b/.test(
    t
  );
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
    body: JSON.stringify({ type: "media", media: { url: mediaUrl } }),
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
    // Check each line separately so a multi-line answer like
    // "Multan\n2\n12sep" (city + travelers + date all at once) is fully
    // captured, instead of only grabbing the first thing that matches.
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const dateWordRe = /(\d{1,2}\s*)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(\s*\d{1,2})?|\b\d{1,2}\/\d{1,2}\b|\b\d{4}\b/i;
    const travelerRe = /\b(\d+)\s*(travel?ers?|people|persons?|adults?|pax)?\b/i;

    for (const line of lines) {
      if (!state.travelInfo.date && dateWordRe.test(line)) {
        state.travelInfo.date = line;
        continue;
      }
      if (!state.travelInfo.travelers && travelerRe.test(line)) {
        state.travelInfo.travelers = line.match(travelerRe)[1];
        continue;
      }
      if (
        !state.travelInfo.city &&
        /^[a-zA-Z\s]{2,30}$/.test(line) &&
        !isVisaOrTicketQuestion(line)
      ) {
        state.travelInfo.city = line;
        continue;
      }
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

  // 5) Fresh inquiry / hasn't gotten the menu yet -> send it.
  // Guarded two ways:
  //  - isShortConversationalReply: short replies ("yes please", "thanks")
  //    clearly respond to *something*, so the full menu is the wrong answer
  //    even if sentMenu looks false (e.g. after a state reset).
  //  - Once a package has been picked (sentPackageNumber set), isFreshInquiry
  //    is no longer trusted to re-trigger a resend on its own: its keyword
  //    list (e.g. "more info") can appear inside an ordinary follow-up
  //    question at this stage ("yes tell me more info" about the package
  //    just sent) and would otherwise wrongly reset them back to the menu.
  const freshInquiryTrusted = isFreshInquiry(text) && !state.sentPackageNumber;
  if ((!state.sentMenu || freshInquiryTrusted) && !isShortConversationalReply(text)) {
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

    // Deduplicate: Blueticks (or the network) can deliver the same webhook
    // more than once. Track recently-seen event IDs and skip repeats.
    const eventId = event.id;
    if (eventId) {
      if (seenEventIds.has(eventId)) {
        return res.sendStatus(200); // already processed this exact event
      }
      seenEventIds.add(eventId);
      // Keep the set from growing forever
      if (seenEventIds.size > 2000) {
        const oldest = seenEventIds.values().next().value;
        seenEventIds.delete(oldest);
      }
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
  } finally {
    // Always persist, even on early-return/dedup/error paths, since
    // seenEventIds or chatState may have changed before the exit point.
    persistState();
  }
});

// Health check endpoint (useful for hosting platforms)
app.get("/", (req, res) => res.send("GoBaku bot is running."));

loadPersistedState();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot listening on port ${PORT}`));
