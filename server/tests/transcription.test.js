/**
 * What groqProvider.transcribe() actually sends to Groq, and how it handles
 * what comes back. fetch is stubbed throughout — no network, no quota spent.
 */

import { describe, it, expect, vi } from "vitest";
import { createGroqProvider } from "../src/ai/groqProvider.js";
import { HttpError } from "../src/ai/retry.js";

/** Builds a provider whose fetch is a spy returning a scripted response. */
function providerWith(responses, overrides = {}) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fetchImpl = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === "function" ? next() : next;
  });

  const provider = createGroqProvider({
    fetchImpl,
    sleep: async () => {}, // never actually wait in tests
    ...overrides,
  });

  return { provider, fetchImpl };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

const WHISPER_OK = {
  text: "  We should ship on Friday.  ",
  segments: [
    { start: 0, end: 1.4, text: " We should ship" },
    { start: 3.2, end: 4.0, text: " on Friday." },
  ],
};

describe("transcribe() request shape", () => {
  it("posts multipart audio to /audio/transcriptions", async () => {
    const { provider, fetchImpl } = providerWith(jsonResponse(WHISPER_OK));
    await provider.transcribe(Buffer.from("fake-audio-bytes"));

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("sends the configured model and asks for verbose_json so turn detection gets timings", async () => {
    const { provider, fetchImpl } = providerWith(jsonResponse(WHISPER_OK));
    await provider.transcribe(Buffer.from("fake-audio-bytes"));

    const form = fetchImpl.mock.calls[0][1].body;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("response_format")).toBe("verbose_json");
    // Deterministic transcription: no creative reinterpretation of audio.
    expect(form.get("temperature")).toBe("0");
  });

  it("attaches the audio as a file with the given mime type", async () => {
    const { provider, fetchImpl } = providerWith(jsonResponse(WHISPER_OK));
    await provider.transcribe(Buffer.from("fake-audio-bytes"), {
      mimeType: "audio/ogg",
      filename: "chunk-7.ogg",
    });

    const file = fetchImpl.mock.calls[0][1].body.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe("audio/ogg");
    expect(file.size).toBe(Buffer.from("fake-audio-bytes").length);
  });

  it("authenticates with a bearer token and never puts the key in the URL", async () => {
    const { provider, fetchImpl } = providerWith(jsonResponse(WHISPER_OK));
    await provider.transcribe(Buffer.from("audio"));

    const [url, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer gsk_test_key_not_a_real_credential");
    expect(url).not.toContain("gsk_");
  });

  it("uses an overridden model without a code change", async () => {
    const { provider, fetchImpl } = providerWith(jsonResponse(WHISPER_OK), {
      config: { transcribeModel: "whisper-large-v3" },
    });
    await provider.transcribe(Buffer.from("audio"));

    expect(fetchImpl.mock.calls[0][1].body.get("model")).toBe("whisper-large-v3");
  });
});

describe("transcribe() response handling", () => {
  it("returns trimmed text and normalised segments", async () => {
    const { provider } = providerWith(jsonResponse(WHISPER_OK));
    const result = await provider.transcribe(Buffer.from("audio"));

    expect(result.text).toBe("We should ship on Friday.");
    expect(result.segments).toEqual([
      { start: 0, end: 1.4, text: "We should ship" },
      { start: 3.2, end: 4.0, text: "on Friday." },
    ]);
  });

  it("survives a response with no segments", async () => {
    const { provider } = providerWith(jsonResponse({ text: "Hello." }));
    const result = await provider.transcribe(Buffer.from("audio"));

    expect(result.text).toBe("Hello.");
    expect(result.segments).toBeUndefined();
  });

  it("returns empty text rather than undefined when Groq returns nothing usable", async () => {
    const { provider } = providerWith(jsonResponse({}));
    const result = await provider.transcribe(Buffer.from("audio"));
    expect(result.text).toBe("");
  });

  it("rejects an empty audio chunk before spending a request", async () => {
    const { provider, fetchImpl } = providerWith(jsonResponse(WHISPER_OK));

    await expect(provider.transcribe(Buffer.alloc(0))).rejects.toThrow(/empty audio chunk/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("transcribe() failure handling", () => {
  it("retries a 429 and succeeds on a later attempt", async () => {
    const { provider, fetchImpl } = providerWith([
      () => new Response("rate limited", { status: 429 }),
      () => jsonResponse(WHISPER_OK),
    ]);

    const result = await provider.transcribe(Buffer.from("audio"));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("We should ship on Friday.");
  });

  it("gives up after 3 attempts and reports the status", async () => {
    const { provider, fetchImpl } = providerWith(
      () => new Response("rate limited", { status: 429 }),
    );

    await expect(provider.transcribe(Buffer.from("audio"))).rejects.toMatchObject({
      status: 429,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a bad API key — that would burn quota for nothing", async () => {
    const { provider, fetchImpl } = providerWith(
      () => new Response("invalid api key", { status: 401 }),
    );

    await expect(provider.transcribe(Buffer.from("audio"))).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not leak the API key into the thrown error", async () => {
    const { provider } = providerWith(() => new Response("invalid api key", { status: 401 }));

    const error = await provider.transcribe(Buffer.from("audio")).catch((e) => e);
    expect(JSON.stringify({ msg: error.message, body: error.body })).not.toContain("gsk_");
  });
});
