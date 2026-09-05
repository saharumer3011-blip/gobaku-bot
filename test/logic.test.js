const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractPackageNumber,
  isVisaOrTicketQuestion,
  isPricingQuestion,
  isFreshInquiry,
  isAffirmative,
  isDetailsRequest,
  isShortConversationalReply,
  normalizeChatId,
  travelInfoComplete,
  nextMissingTravelInfoQuestion,
} = require("../index.js");

test("extractPackageNumber", async (t) => {
  await t.test("matches a bare digit", () => {
    assert.equal(extractPackageNumber("3"), 3);
  });

  await t.test("matches 'package N' phrasing", () => {
    assert.equal(extractPackageNumber("I want package number 5"), 5);
    assert.equal(extractPackageNumber("pkg no. 2"), 2);
  });

  await t.test("matches an emoji-style digit after stripping invisible chars", () => {
    assert.equal(extractPackageNumber("1​"), 1);
  });

  await t.test("matches a duration label", () => {
    assert.equal(extractPackageNumber("9N/10D"), 7);
    assert.equal(extractPackageNumber("6 nights 7 days"), 4);
  });

  await t.test("rejects an inconsistent duration label", () => {
    assert.equal(extractPackageNumber("9 nights 12 days"), null);
  });

  await t.test("returns null for unrelated text", () => {
    assert.equal(extractPackageNumber("what's included?"), null);
    assert.equal(extractPackageNumber(""), null);
    assert.equal(extractPackageNumber(null), null);
  });

  await t.test("rejects out-of-range numbers", () => {
    assert.equal(extractPackageNumber("9"), null);
    assert.equal(extractPackageNumber("0"), null);
  });
});

test("isVisaOrTicketQuestion", () => {
  assert.equal(isVisaOrTicketQuestion("Do I need a visa?"), true);
  assert.equal(isVisaOrTicketQuestion("Is airfare included?"), true);
  assert.equal(isVisaOrTicketQuestion("Hello, more info please"), false);
  assert.equal(isVisaOrTicketQuestion(""), false);
});

test("isPricingQuestion", () => {
  assert.equal(isPricingQuestion("What's the total cost?"), true);
  assert.equal(isPricingQuestion("How much in PKR?"), true);
  assert.equal(isPricingQuestion("Do you have a visa?"), false);
});

test("isFreshInquiry", () => {
  assert.equal(isFreshInquiry("Hello, more info"), true);
  assert.equal(isFreshInquiry("Tell me about Baku packages"), true);
  assert.equal(isFreshInquiry("2"), false);
});

test("isAffirmative", () => {
  assert.equal(isAffirmative("Yes"), true);
  assert.equal(isAffirmative(" haan "), true);
  assert.equal(isAffirmative("yes please"), false); // multi-word, not exact
  assert.equal(isAffirmative("no"), false);
});

test("isDetailsRequest", () => {
  assert.equal(isDetailsRequest("Can you share more details?"), true);
  assert.equal(isDetailsRequest("tell me more"), true);
  assert.equal(isDetailsRequest("yes"), false);
});

test("isShortConversationalReply", () => {
  assert.equal(isShortConversationalReply("yes please"), true);
  assert.equal(isShortConversationalReply("Thank you"), true);
  assert.equal(
    isShortConversationalReply("What is included in the visa process for two people?"),
    false
  );
  assert.equal(isShortConversationalReply(""), false);
});

test("normalizeChatId", () => {
  assert.equal(normalizeChatId("923001234567"), "923001234567@c.us");
  assert.equal(normalizeChatId("+92 300 1234567"), "923001234567@c.us");
  assert.equal(normalizeChatId("923001234567@c.us"), "923001234567@c.us");
  assert.equal(normalizeChatId(""), null);
  assert.equal(normalizeChatId(null), null);
});

test("travelInfoComplete / nextMissingTravelInfoQuestion", () => {
  const empty = { travelInfo: { travelers: null, city: null, date: null } };
  assert.equal(travelInfoComplete(empty), false);
  assert.equal(nextMissingTravelInfoQuestion(empty), "How many travelers will there be?");

  const partial = { travelInfo: { travelers: "2", city: null, date: null } };
  assert.equal(nextMissingTravelInfoQuestion(partial), "Which city will you be traveling from?");

  const full = { travelInfo: { travelers: "2", city: "Lahore", date: "12 Sep" } };
  assert.equal(travelInfoComplete(full), true);
  assert.equal(nextMissingTravelInfoQuestion(full), null);
});
