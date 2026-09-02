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

// Tracks message IDs the bot itself just sent. Used to tell the bot's own
// outgoing messages apart from a human agent manually replying from
// WhatsApp Web -- both arrive as `fromMe: true` webhook events and look
// identical otherwise. If an outgoing message's ID isn't in this set, a
// human sent it, and the bot should stop auto-replying in that chat.
const botSentMessageIds = new Set();

/**
 * Best-effort extraction of a message ID from a Blueticks send response.
 * The exact field name isn't confirmed from docs -- if human-handoff
 * detection isn't working (bot keeps replying after a human message, or
 * pauses immediately after its own first message), check the Railway
 * deploy logs for the actual send-response JSON shape (logged below) and
 * adjust the field names checked here to match.
 */
function extractMessageId(responseBodyText) {
  try {
    const parsed = JSON.parse(responseBodyText);
    const id =
      parsed.id ||
      parsed.messageId ||
      parsed?.data?.id ||
      parsed?.data?.messageId;
    return id || null;
  } catch {
    return null;
  }
}

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
      pausedByHuman: false,
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
 * True if the client is asking for more details/info about the package
 * (e.g. "details", "more info", "tell me more", "full details"). Treated
 * the same as an affirmative answer to the satisfaction question -- asking
 * for details means they're interested and want to move forward, not that
 * they're declining the package.
 */
function isDetailsRequest(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return /\b(details?|more\s*info(rmation)?|full\s*details|tell\s*me\s*more|information)\b/.test(
    t
  );
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
  const msgId = extractMessageId(body);
  if (msgId) botSentMessageIds.add(msgId);
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
  const msgId = extractMessageId(body);
  if (msgId) botSentMessageIds.add(msgId);
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

  // A human agent has already replied in this chat directly (see webhook
  // handler) -- stay out of the way entirely and let them handle it.
  if (state.pausedByHuman) {
    console.log(`Skipping auto-reply for ${chatId}: human has taken over this chat.`);
    return;
  }

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
    state.sentPackageNumber = pkgNum; // claim before awaiting — see race-condition note above
    await sendMedia(chatId, PACKAGE_PDFS[pkgNum]);
    await markRead(chatId);
    return;
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

  // 5) Fresh inquiry / hasn't gotten the menu yet -> send the package list
  // AND the travel-info question together, right away. This is now the
  // bot's entire job for a new conversation: after this one exchange, hand
  // off to a human immediately (pausedByHuman = true) -- no satisfaction
  // question, no waiting for a package number first. A human can still
  // manually resume the bot for this chat later from the admin page if
  // that's ever wanted (e.g. to let it keep collecting travel info).
  //
  // Trigger is simply "hasn't gotten the menu yet" (!state.sentMenu). We
  // deliberately do NOT also re-trigger this on isFreshInquiry() keywords
  // anymore -- that used to be a safety net for state-loss recovery, but
  // in this one-shot-then-pause design there's no sentPackageNumber left to
  // guard it, and ordinary follow-up questions very commonly contain a
  // trigger word like "package" (e.g. "what's covered under these
  // packages?"), which was wrongly resending the full menu mid-conversation.
  // Persistence + pausedByHuman are now the actual safety net instead.
  if (!state.sentMenu && !isShortConversationalReply(text)) {
    // Claim this state transition BEFORE sending anything. If two messages
    // arrive from the same client almost simultaneously, awaiting the sends
    // below gives Node a chance to start handling the second one before the
    // first finishes -- setting these flags first ensures the second call
    // sees sentMenu/pausedByHuman already true and skips, instead of both
    // independently sending the full menu + travel-info question twice.
    state.sentMenu = true;
    state.awaitingTravelInfo = true;
    state.pausedByHuman = true;
    await sendText(chatId, PACKAGE_MENU);
    await sendText(chatId, TRAVEL_INFO_QUESTION);
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
    function rememberSeenId(id) {
      seenEventIds.add(id);
      // Keep the set from growing forever
      if (seenEventIds.size > 4000) {
        const oldest = seenEventIds.values().next().value;
        seenEventIds.delete(oldest);
      }
    }

    const eventId = event.id;
    if (eventId) {
      if (seenEventIds.has(eventId)) {
        return res.sendStatus(200); // already processed this exact event
      }
      rememberSeenId(eventId);
    }

    const payload = event.data || {};
    const chatId = payload.chatId;
    const type = payload.type || "chat";
    const text = payload.body;
    const fromMe = payload.fromMe;
    const messageId = payload.id?._serialized || payload.messageId;

    if (!chatId) {
      return res.sendStatus(200);
    }

    // Second dedup layer: the wrapping *event* ID can differ across
    // redeliveries of the same underlying WhatsApp message (this happened
    // in practice after a WhatsApp-engine disconnect/reconnect, where
    // Blueticks appears to redeliver queued messages as fresh events).
    // The WhatsApp message ID itself stays stable across redeliveries, so
    // check that too -- this is what actually stops duplicate replies.
    if (!fromMe && messageId) {
      const dedupKey = `msg:${messageId}`;
      if (seenEventIds.has(dedupKey)) {
        return res.sendStatus(200); // same underlying message, redelivered
      }
      rememberSeenId(dedupKey);
    }

    // Only genuine conversational message types count as a possible human
    // reply. WhatsApp/Meta also fires system/template events with
    // fromMe:true -- e.g. "notification_template" for the automatic "data
    // sharing for customer-related activities" notice attached to
    // ad-originated chats. Those aren't a human typing anything, but were
    // incorrectly triggering the human-takeover pause on brand-new
    // conversations before the bot ever got a chance to respond.
    const HUMAN_MESSAGE_TYPES = new Set([
      "chat",
      "text",
      "image",
      "video",
      "audio",
      "ptt",
      "document",
      "sticker",
      "vcard",
      "multi_vcard",
      "location",
    ]);

    if (fromMe) {
      if (!HUMAN_MESSAGE_TYPES.has(type)) {
        // System/template/notification event -- not a real message, ignore.
        return res.sendStatus(200);
      }
      // This is a genuine outgoing message -- either the bot's own
      // automated reply, or a human agent typing directly in WhatsApp Web.
      // Tell them apart via the tracked message-ID set (see
      // botSentMessageIds above).
      if (messageId && botSentMessageIds.has(messageId)) {
        botSentMessageIds.delete(messageId); // it was us; nothing to do
      } else {
        // Not a message we sent -> a human took over this chat. Pause the
        // bot here so it stops auto-replying once a human has stepped in.
        const state = getState(chatId);
        if (!state.pausedByHuman) {
          state.pausedByHuman = true;
          console.log(`Human agent replied in chat ${chatId} -- pausing bot for this chat.`);
          persistState();
        }
      }
      return res.sendStatus(200);
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

// ---------------------------------------------------------------------------
// Manual admin control: pause/resume the bot for a specific chat.
//
// Since Blueticks doesn't appear to deliver a webhook event for outgoing
// messages (neither the bot's own sends nor a human typing/recording in
// WhatsApp Web -- see the human-handoff comments above), the bot has no
// reliable way to *automatically* detect that a human has stepped into a
// conversation. This page is the reliable fallback: a human explicitly
// tells the bot to stand down for a chat, and explicitly tells it to
// resume when they're done.
//
// SETUP: set an ADMIN_SECRET env var to a long random string in Railway
// (Variables tab). The page is only reachable at /admin/<that exact secret>
// -- without it set, these routes always 404, so nothing is exposed by
// accident.
// ---------------------------------------------------------------------------
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

function isAdminAuthed(req) {
  return !!ADMIN_SECRET && req.params.secret === ADMIN_SECRET;
}

/** Accepts a raw phone number or a full chatId and returns a chatId. */
function normalizeChatId(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : null;
}

function renderAdminPage(secret) {
  const rows = Array.from(chatState.entries())
    .map(([chatId, state]) => {
      const paused = !!state.pausedByHuman;
      return `<tr>
        <td>${chatId}</td>
        <td>${paused ? "🔴 Paused (human handling)" : "🟢 Bot active"}</td>
        <td><button onclick="act('${paused ? "resume" : "pause"}','${chatId}')">${
        paused ? "Resume bot" : "Pause bot"
      }</button></td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>GoBaku Bot Control</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;background:#111;color:#eee}
h1{font-size:20px}
p{color:#aaa;font-size:14px;line-height:1.5}
table{width:100%;border-collapse:collapse;margin-top:20px}
td,th{padding:10px 8px;border-bottom:1px solid #333;text-align:left;font-size:14px}
button{background:#25D366;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;color:#000;font-weight:600;font-size:13px}
input{padding:9px;border-radius:6px;border:1px solid #444;background:#222;color:#eee;width:240px;font-size:14px}
.row{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
#msg{margin-top:10px;font-size:13px;color:#f88}
</style></head>
<body>
<h1>GoBaku Bot — Chat Control</h1>
<p>Pause a chat whenever a human is handling that client directly (e.g. answering a price negotiation), so the bot stops auto-replying there. Resume when you're done and want the bot back in charge.</p>
<div class="row">
  <input id="chatIdInput" placeholder="Phone number or chat ID, e.g. 923001234567" />
  <button onclick="pauseManual()">Pause</button>
  <button onclick="resumeManual()">Resume</button>
</div>
<div id="msg"></div>
<table>
<thead><tr><th>Chat</th><th>Status</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="3">No tracked chats yet.</td></tr>'}</tbody>
</table>
<script>
const SECRET = ${JSON.stringify(secret)};
async function act(action, chatId) {
  document.getElementById('msg').textContent = '';
  const res = await fetch('/admin/' + SECRET + '/' + action, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ chatId })
  });
  if (res.ok) location.reload();
  else document.getElementById('msg').textContent = 'Error: ' + (await res.text());
}
function pauseManual() {
  const v = document.getElementById('chatIdInput').value;
  if (v) act('pause', v);
}
function resumeManual() {
  const v = document.getElementById('chatIdInput').value;
  if (v) act('resume', v);
}
</script>
</body></html>`;
}

app.get("/admin/:secret", (req, res) => {
  if (!isAdminAuthed(req)) return res.status(404).send("Not found");
  res.send(renderAdminPage(req.params.secret));
});

app.post("/admin/:secret/pause", (req, res) => {
  if (!isAdminAuthed(req)) return res.status(404).send("Not found");
  const chatId = normalizeChatId(req.body?.chatId);
  if (!chatId) return res.status(400).send("Missing/invalid chatId");
  const state = getState(chatId);
  state.pausedByHuman = true;
  persistState();
  console.log(`[ADMIN] Paused chat ${chatId}`);
  res.sendStatus(200);
});

app.post("/admin/:secret/resume", (req, res) => {
  if (!isAdminAuthed(req)) return res.status(404).send("Not found");
  const chatId = normalizeChatId(req.body?.chatId);
  if (!chatId) return res.status(400).send("Missing/invalid chatId");
  const state = getState(chatId);
  state.pausedByHuman = false;
  persistState();
  console.log(`[ADMIN] Resumed chat ${chatId}`);
  res.sendStatus(200);
});

// Health check endpoint (useful for hosting platforms)
app.get("/", (req, res) => res.send("GoBaku bot is running."));

loadPersistedState();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot listening on port ${PORT}`));
