/**
 * The AiProvider contract itself: shape checking and result validation.
 *
 * The fake provider defined here is the same one used to exercise routes and
 * socket handlers without touching the real API.
 */

import { describe, it, expect } from "vitest";
import { assertValidProvider, parseMinutes } from "../src/ai/provider.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";

describe("assertValidProvider", () => {
  it("accepts a well-formed provider and returns it", () => {
    const provider = createFakeProvider();
    expect(assertValidProvider(provider)).toBe(provider);
  });

  it("accepts the real Groq provider's shape", async () => {
    const { createGroqProvider } = await import("../src/ai/groqProvider.js");
    // Constructed with a stub fetch so no network call is possible.
    const provider = createGroqProvider({ fetchImpl: async () => new Response("{}") });
    expect(() => assertValidProvider(provider)).not.toThrow();
  });

  it("rejects a provider missing transcribe()", () => {
    const broken = { name: "broken", summarize: async () => ({}) };
    expect(() => assertValidProvider(broken)).toThrow(/missing transcribe\(\)/);
  });

  it("rejects a provider missing summarize()", () => {
    const broken = { name: "broken", transcribe: async () => ({}) };
    expect(() => assertValidProvider(broken)).toThrow(/missing summarize\(\)/);
  });

  it("names both methods when both are missing", () => {
    expect(() => assertValidProvider({ name: "empty" })).toThrow(
      /missing transcribe\(\) and summarize\(\)/,
    );
  });

  it("rejects a typo'd method name rather than failing later at call time", () => {
    // The exact mistake this check exists to catch.
    const typo = { name: "typo", transcibe: async () => ({}), summarize: async () => ({}) };
    expect(() => assertValidProvider(typo)).toThrow(/missing transcribe\(\)/);
  });

  it("rejects a non-object", () => {
    expect(() => assertValidProvider(null)).toThrow(/must be an object, received null/);
    expect(() => assertValidProvider(undefined)).toThrow(/must be an object/);
    expect(() => assertValidProvider("groq")).toThrow(/must be an object, received string/);
  });

  it("rejects properties that exist but are not functions", () => {
    const broken = { name: "broken", transcribe: "yes", summarize: 42 };
    expect(() => assertValidProvider(broken)).toThrow(/missing transcribe\(\) and summarize\(\)/);
  });
});

describe("parseMinutes", () => {
  const valid = {
    decisions: ["Ship on Friday"],
    action_items: [{ task: "Run the migration", owner: "Bob", due: "Thursday" }],
    open_questions: ["Do we need a rollback plan?"],
  };

  it("accepts a well-formed result unchanged", () => {
    expect(parseMinutes(valid)).toEqual(valid);
  });

  it("accepts empty arrays — a meeting can genuinely decide nothing", () => {
    const empty = { decisions: [], action_items: [], open_questions: [] };
    expect(parseMinutes(empty)).toEqual(empty);
  });

  it("fills in owner and due so the UI never renders undefined", () => {
    const partial = {
      decisions: [],
      action_items: [{ task: "Write the postmortem" }],
      open_questions: [],
    };
    expect(parseMinutes(partial).action_items[0]).toEqual({
      task: "Write the postmortem",
      owner: "Unassigned",
      due: "Not specified",
    });
  });

  it("rejects a missing top-level key with a readable message", () => {
    expect(() => parseMinutes({ decisions: [], action_items: [] })).toThrow(
      /open_questions/,
    );
  });

  it("rejects a string where an array belongs", () => {
    expect(() =>
      parseMinutes({ decisions: "we shipped", action_items: [], open_questions: [] }),
    ).toThrow(/unexpected shape/);
  });

  it("rejects an action item with no task", () => {
    expect(() =>
      parseMinutes({
        decisions: [],
        action_items: [{ owner: "Bob", due: "Friday" }],
        open_questions: [],
      }),
    ).toThrow(/task/);
  });

  it("rejects null and non-objects", () => {
    expect(() => parseMinutes(null)).toThrow(/unexpected shape/);
    expect(() => parseMinutes("{}")).toThrow(/unexpected shape/);
  });
});
