import { describe, expect, it } from "vitest";
import {
  completeReviewTranscript,
  sourceConversationId,
  validateReviewFix,
  verifiedCustomerAddress,
  type ReviewMessage,
} from "../../supabase/functions/_shared/urgent-review";

const message = (id: string, sender: string, text: string): ReviewMessage =>
  ({ id, sender, text, message_time: "2026-10-09T12:00:00Z" });

const chat: ReviewMessage[] = [
  message("m1", "customer", "i need a painting service for a two story house"),
  message("m2", "agent", "we can do the trim and doors for 600"),
  message("m3", "customer", "actually add gutters too, and the price is fine"),
  message("m4", "agent", "call transcript summary: customer confirmed 640 total"),
];

const record = { service_details: "paint the exterior of a two story house", quote: "", customer_name: "Piyush" };

describe("urgent review reads the latest agreement", () => {
  it("accepts a corrected scope when the customer confirmed it in the chat", () => {
    const fix = validateReviewFix({
      field: "service_details", current: record.service_details,
      suggested: "Paint the exterior and trim of a two story house, including gutters. Windows and doors are excluded.",
      reason: "Customer added gutters after the initial request.", kind: "latest_agreement",
      agreement_message_id: "m3",
      evidence: [{ message_id: "m3", quote: "actually add gutters too" }],
    }, record, chat);
    expect(fix?.suggested).toContain("gutters");
  });

  // The reported defect: the AI kept the initial service and ignored later work.
  it("rejects an agent-only summary as proof of the customer agreement", () => {
    expect(validateReviewFix({
      field: "quote", current: "", suggested: "640", kind: "latest_agreement",
      agreement_message_id: "m4",
      evidence: [{ message_id: "m4", quote: "customer confirmed 640 total" }],
    }, record, chat)).toBeNull();
  });

  it("rejects an unsupported or unverifiable change", () => {
    // The customer never stated 999, so a valid-looking quote is still rejected.
    expect(validateReviewFix({ field: "quote", current: "", suggested: "999", agreement_message_id: "m1", evidence: [{ message_id: "m1", quote: "i need a painting service" }] }, record, chat)).toBeNull();
    expect(validateReviewFix({ field: "address", current: "a", suggested: "b" }, record, chat)).toBeNull();
    expect(validateReviewFix({ field: "service_details", current: record.service_details, suggested: "x" }, record, chat)).toBeNull();
    // A quote the agent offered, which the customer never confirmed.
    expect(validateReviewFix({ field: "quote", current: "", suggested: "600", agreement_message_id: "m2", evidence: [{ message_id: "m2", quote: "we can do the trim and doors for 600" }] }, record, chat)).toBeNull();
  });

  it("accepts a price the customer confirmed in the chat", () => {
    const agreed = [...chat, message("m6", "customer", "yes, 640 total is agreed")];
    expect(validateReviewFix({
      field: "quote", current: "", suggested: "640", agreement_message_id: "m6",
      evidence: [{ message_id: "m6", quote: "640 total is agreed" }],
    }, record, agreed)?.suggested).toBe("640");
  });

  it("normalizes a service name to the canonical option", () => {
    expect(validateReviewFix({ field: "service_type", current: "garage door repair", suggested: "Garage Door Repair" }, { service_type: "garage door repair" }, chat)?.suggested).toBe("Garage Door Repair");
    // Not a real service option: never applied.
    expect(validateReviewFix({ field: "service_type", current: "handyman", suggested: "Handyman" }, { service_type: "handyman" }, chat)).toBeNull();
  });

  it("reads the service address only from the customer's own message", () => {
    expect(verifiedCustomerAddress({ address: "755 vienna st san francisco ca 94112", message_id: "m1", quote: "755 vienna st san francisco ca 94112" }, chat)).toBeNull();
    const withAddress = [...chat, message("m5", "customer", "the house is at 755 vienna st san francisco ca 94112")];
    expect(verifiedCustomerAddress({ address: "755 vienna st san francisco ca 94112", message_id: "m5", quote: "755 vienna st san francisco ca 94112" }, withAddress)).toBe("755 vienna st san francisco ca 94112");
    expect(verifiedCustomerAddress({ address: "1 invented road", message_id: "m5", quote: "the house is at 755 vienna st" }, withAddress)).toBeNull();
  });

  it("reads a Quo conversation id only from a Quo link", () => {
    expect(sourceConversationId("https://my.quo.com/inbox/CN1234567890/PN9876543210")).toBe("CN1234567890");
    expect(sourceConversationId("https://evil.example.com/inbox/CN1234567890")).toBeNull();
    expect(sourceConversationId(null)).toBeNull();
  });

  it("refuses a pass when the full history does not fit, rather than reviewing part of it", () => {
    const long = [message("m1", "customer", "x".repeat(1_000))];
    expect(completeReviewTranscript(long, 500)).toBeNull();
    expect(completeReviewTranscript(chat, 200_000)).toContain("m1");
  });
});