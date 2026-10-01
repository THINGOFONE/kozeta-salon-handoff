import { describe, it, expect } from "vitest";
import {
  findMatchingClients,
  findMatchingClientsByEmail,
  normalizePhoneForSearch,
  phonesMatch,
} from "./authUtils";

const client = (clientId: string, mobile?: string, landline?: string, email?: string) => ({
  clientId,
  mobile,
  landline,
  email,
  firstName: "Test",
  lastName: clientId,
});

describe("normalizePhoneForSearch", () => {
  it("normalizes 10-digit numbers to +1 format", () => {
    expect(normalizePhoneForSearch("4165551234")).toBe("+14165551234");
    expect(normalizePhoneForSearch("(416) 555-1234")).toBe("+14165551234");
  });

  it("normalizes 11-digit numbers starting with 1", () => {
    expect(normalizePhoneForSearch("14165551234")).toBe("+14165551234");
  });
});

describe("phonesMatch", () => {
  it("matches on last 10 digits", () => {
    expect(phonesMatch("4165551234", "+14165551234")).toBe(true);
  });

  it("returns false for empty inputs", () => {
    expect(phonesMatch("", "4165551234")).toBe(false);
    expect(phonesMatch("4165551234", "")).toBe(false);
  });

  it("does not match different numbers", () => {
    expect(phonesMatch("4165551234", "4165559999")).toBe(false);
  });
});

describe("findMatchingClients", () => {
  it("returns null with no ambiguity when nothing matches", () => {
    const result = findMatchingClients([client("a", "4165559999")], "4165551234");
    expect(result.client).toBeNull();
    expect(result.ambiguous).toBe(false);
  });

  it("returns the single matching client", () => {
    const c = client("a", "+14165551234");
    const result = findMatchingClients([c, client("b", "4165559999")], "4165551234");
    expect(result.client).toBe(c);
    expect(result.ambiguous).toBe(false);
  });

  it("matches on landline too", () => {
    const c = client("a", undefined, "+14165551234");
    const result = findMatchingClients([c], "4165551234");
    expect(result.client).toBe(c);
  });

  it("de-duplicates the same client returned multiple times", () => {
    const c = client("same-id", "+14165551234");
    const dup = client("same-id", "+14165551234");
    const result = findMatchingClients([c, dup, c], "4165551234");
    expect(result.client).toBe(c);
    expect(result.ambiguous).toBe(false);
  });

  it("prefers an exact full-digit match over a last-10-digit match", () => {
    // Search with full digits "+14165551234"; exact match beats a client whose
    // stored number only matches on the last 10 digits (e.g. +44... prefix).
    const exact = client("exact", "+14165551234");
    const last10 = client("last10", "+441004165551234".slice(0, 6) + "4165551234"); // different prefix, same last 10
    const result = findMatchingClients([last10, exact], "+14165551234");
    expect(result.client).toBe(exact);
    expect(result.ambiguous).toBe(false);
  });

  it("flags ambiguity when multiple distinct clients share the number", () => {
    const a = client("a", "+14165551234");
    const b = client("b", "+14165551234");
    const result = findMatchingClients([a, b], "4165551234");
    expect(result.client).toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  it("flags ambiguity when multiple exact matches exist", () => {
    const a = client("a", "+14165551234");
    const b = client("b", undefined, "+14165551234");
    const result = findMatchingClients([a, b], "+14165551234");
    expect(result.client).toBeNull();
    expect(result.ambiguous).toBe(true);
  });
});

describe("findMatchingClientsByEmail", () => {
  it("matches only exact normalized emails", () => {
    const c = client("a", undefined, undefined, "Jane@Example.com");
    const result = findMatchingClientsByEmail(
      [c, client("b", undefined, undefined, "other@example.com")],
      "jane@example.com "
    );
    expect(result.client).toBe(c);
    expect(result.ambiguous).toBe(false);
  });

  it("de-duplicates same client by id", () => {
    const c = client("same", undefined, undefined, "jane@example.com");
    const result = findMatchingClientsByEmail([c, { ...c }], "jane@example.com");
    expect(result.client?.clientId).toBe("same");
    expect(result.ambiguous).toBe(false);
  });

  it("flags ambiguity for distinct clients sharing an email", () => {
    const a = client("a", undefined, undefined, "shared@example.com");
    const b = client("b", undefined, undefined, "shared@example.com");
    const result = findMatchingClientsByEmail([a, b], "shared@example.com");
    expect(result.client).toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  it("returns no match for empty email", () => {
    const result = findMatchingClientsByEmail([client("a")], "");
    expect(result.client).toBeNull();
    expect(result.ambiguous).toBe(false);
  });
});
