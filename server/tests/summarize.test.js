/**
 * Summarization prompt construction and the exact request shape sent to Groq.
 *
 * The spec calls this out specifically: given a transcript, assert what goes
 * over the wire. fetch is stubbed — no network, no quota spent.
 */

import { describe, it, expect, vi } from "vitest";
import { createGroqProvider } from "../src/ai/groqProvider.js";
import {
  buildSummaryMessages,
  buildSummaryUserPrompt,
  SUMMARY_SYSTEM_PROMPT,
} from "../src/ai/prompts.js";

const TRANSCRIPT = [
  "Speaker 1: We should ship on Friday.",
  "Speaker 2: I'll run the migration by Thursday.",
  "Speaker 1: Do we need a rollback plan?",
].join("\n");

const MINUTES = {
  decisions: ["Ship on Friday"],
  action_items: [{ task: "Run the migration", owner: "Speaker 2", due: "Thursday" }],
  open_questions: ["Do we need a rollback plan?"],
};

function providerWith(responses, overrides = {}) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fetchImpl = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === "function" ? next() : next;
  });

  return {
    provider: createGroqProvider({ fetchImpl, sleep: async () => {}, ...overrides }),
    fetchImpl,
  };
}

/** Wraps a minutes object the way the chat completions API returns it. */
function completion(content) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("prompt construction", () => {
  it("produces a system message then a user message", () => {
    const messages = buildSummaryMessages(TRANSCRIPT);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("puts the full transcript in the user message", () => {
    const messages = buildSummaryMessages(TRANSCRIPT);

    expect(messages[1].content).toContain("We should ship on Friday.");
    expect(messages[1].content).toContain("I'll run the migration by Thursday.");
    expect(messages[1].content).toContain("Do we need a rollback plan?");
  });

  it("asks for exactly the three keys the database stores", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain("decisions");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("action_items");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("open_questions");
  });

  it("instructs the model not to invent owners or dates", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Unassigned/);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Not specified/);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Never invent/i);
  });

  it("tells the model an action item is not also a decision", () => {
    // The exact failure observed when comparing candidate models.
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Never list the\s+same thing in both/);
  });

  it("permits empty arrays so a quiet meeting is not padded", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/empty array is a correct answer/);
  });

  it("trims surrounding whitespace from the transcript", () => {
    expect(buildSummaryUserPrompt("   hello   ")).toContain("\n---\nhello\n---\n");
  });
});

describe("summarize() request shape", () => {
  it("posts to /chat/completions as JSON", async () => {
    const { provider, fetchImpl } = providerWith(completion(MINUTES));
    await provider.summarize(TRANSCRIPT);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("sends the configured model, JSON mode, and a low temperature", async () => {
    const { provider, fetchImpl } = providerWith(completion(MINUTES));
    await provider.summarize(TRANSCRIPT);

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("openai/gpt-oss-120b");
    // Ask the API to guarantee JSON rather than hoping the prompt is obeyed.
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.temperature).toBe(0.2);
  });

  it("sends exactly the messages the prompt builder produced", async () => {
    const { provider, fetchImpl } = providerWith(completion(MINUTES));
    await provider.summarize(TRANSCRIPT);

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages).toEqual(buildSummaryMessages(TRANSCRIPT));
  });

  it("uses an overridden summary model without a code change", async () => {
    const { provider, fetchImpl } = providerWith(completion(MINUTES), {
      config: { summaryModel: "qwen/qwen3.8-27b" },
    });
    await provider.summarize(TRANSCRIPT);

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe("qwen/qwen3.8-27b");
  });

  it("rejects an empty transcript before spending a request", async () => {
    const { provider, fetchImpl } = providerWith(completion(MINUTES));

    await expect(provider.summarize("   ")).rejects.toThrow(/empty transcript/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("summarize() response handling", () => {
  it("parses and returns validated minutes", async () => {
    const { provider } = providerWith(completion(MINUTES));
    expect(await provider.summarize(TRANSCRIPT)).toEqual(MINUTES);
  });

  it("applies defaults for a missing owner and due date", async () => {
    const { provider } = providerWith(
      completion({ decisions: [], action_items: [{ task: "Follow up" }], open_questions: [] }),
    );

    const result = await provider.summarize(TRANSCRIPT);
    expect(result.action_items[0]).toEqual({
      task: "Follow up",
      owner: "Unassigned",
      due: "Not specified",
    });
  });

  it("retries unparseable JSON, since it is usually a one-off sampling artefact", async () => {
    const { provider, fetchImpl } = providerWith([
      () => completion("this is not json at all"),
      () => completion(MINUTES),
    ]);

    expect(await provider.summarize(TRANSCRIPT)).toEqual(MINUTES);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws after retries when the model keeps returning the wrong shape", async () => {
    const { provider } = providerWith(() =>
      completion({ decisions: "not an array", action_items: [], open_questions: [] }),
    );

    await expect(provider.summarize(TRANSCRIPT)).rejects.toThrow(/unexpected shape/);
  });

  it("throws on an empty completion rather than returning empty minutes", async () => {
    const { provider } = providerWith(() => completion(""));
    await expect(provider.summarize(TRANSCRIPT)).rejects.toThrow(/empty summarization response/);
  });

  it("retries a 429 and succeeds on a later attempt", async () => {
    const { provider, fetchImpl } = providerWith([
      () => new Response("rate limited", { status: 429 }),
      () => completion(MINUTES),
    ]);

    expect(await provider.summarize(TRANSCRIPT)).toEqual(MINUTES);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
