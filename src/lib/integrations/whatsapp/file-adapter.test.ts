import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { fileImport, memoryFile, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, Message } from "../core/vocab.js";
import { parseWhatsappChat, whatsappFileAdapter } from "./file-adapter.js";

const DOC = `${TEST_POD_ROOT}integrations/whatsapp/social/whatsapp-chat.ttl`;

const IOS_SAMPLE = `[14/02/2023, 09:30:15] Alice: Hello there
[14/02/2023, 09:31:02] Bob: Hi! How are you?
This is a second line of Bob's message
[14/02/2023, 09:32:00] Alice: Good, thanks 😀`;

const ANDROID_SAMPLE = `2/14/23, 9:30 AM - Messages are end-to-end encrypted.
2/14/23, 9:31 AM - Alice: Morning
2/14/23, 9:32 PM - Bob: Evening`;

describe("whatsapp file adapter", () => {
  it("writes each message as a schema:Message in Social", async () => {
    const { pod, report } = await fileImport(
      whatsappFileAdapter,
      memoryFile("_chat.txt", IOS_SAMPLE, "text/plain"),
    );
    expect(report.categories).toEqual(["social"]);
    const ds = pod.dataset(DOC);
    const types = [...ds].filter(
      (q) => q.object.value === CLASSES.Message && q.predicate.value.endsWith("type"),
    );
    expect(types).toHaveLength(3);
  });

  it("joins continuation lines and keeps sender + timestamp", async () => {
    const { pod } = await fileImport(
      whatsappFileAdapter,
      memoryFile("_chat.txt", IOS_SAMPLE, "text/plain"),
    );
    const ds = pod.dataset(DOC);
    const textQuad = [...ds].find(
      (q) => q.predicate.value === "https://schema.org/text" && q.object.value.startsWith("Hi! How are you?"),
    );
    expect(textQuad).toBeDefined();
    const m = new Message(textQuad!.subject.value, ds, DataFactory);
    expect(m.sender).toBe("Bob");
    expect(m.text).toBe("Hi! How are you?\nThis is a second line of Bob's message");
    expect(m.dateCreated?.toISOString()).toBe("2023-02-14T09:31:02.000Z");
  });

  it("registers Message in the type index", async () => {
    const { pod, report } = await fileImport(
      whatsappFileAdapter,
      memoryFile("_chat.txt", IOS_SAMPLE, "text/plain"),
    );
    expect(pod.get(report.indexUrl)).toContain(CLASSES.Message);
  });
});

describe("parseWhatsappChat", () => {
  it("parses the Android dash format and skips system lines", () => {
    const msgs = parseWhatsappChat(ANDROID_SAMPLE);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].sender).toBe("Alice");
    expect(msgs[1].sender).toBe("Bob");
    // 9:32 PM → 21:32 UTC
    expect(msgs[1].when?.toISOString()).toBe("2023-02-14T21:32:00.000Z");
  });

  it("respects the limit", () => {
    expect(parseWhatsappChat(IOS_SAMPLE, 1)).toHaveLength(1);
  });
});
