/**
 * Prompt construction for summarization.
 *
 * Lives in ai/ rather than services/ because it is provider-facing: it shapes
 * the request sent to the model. services/summarize.js orchestrates around it
 * (load transcript, call provider, persist, handle failure).
 *
 * Kept as a pure function so the exact request shape can be asserted in tests
 * without any network call.
 */

/**
 * Guardrails encode the mistakes models actually make on this task: restating an
 * action item as a decision, inventing owners and deadlines that were never
 * said, and padding output when a meeting genuinely decided nothing.
 */
export const SUMMARY_SYSTEM_PROMPT = `You extract structured minutes from meeting transcripts.

Return ONLY a JSON object with exactly these three keys:

{
  "decisions": [string],
  "action_items": [{ "task": string, "owner": string, "due": string }],
  "open_questions": [string]
}

Rules:
- decisions: concrete choices the group settled on. Something the group agreed to
  DO, assigned to a person, is an action item, not a decision. Never list the
  same thing in both.
- action_items: tasks someone committed to. "owner" is the person's name exactly
  as it appears in the transcript, or "Unassigned" if nobody took it. "due" is
  the deadline as stated, or "Not specified". Never invent an owner or a date.
- open_questions: questions raised that were not resolved during the meeting.
- Use only what is in the transcript. Do not infer, embellish, or add plausible
  items that were never said.
- Any of the three arrays may be empty. An empty array is a correct answer when
  the meeting produced nothing of that kind. Do not pad.
- Keep each entry to a single clear sentence.`;

/** Transcripts are pasted in whole; this marks the boundary explicitly. */
export function buildSummaryUserPrompt(transcript) {
  return `Here is the meeting transcript.\n\n---\n${transcript.trim()}\n---\n\nProduce the JSON object described in your instructions.`;
}

/**
 * The full messages array sent to the chat completions endpoint.
 *
 * @param {string} transcript
 * @returns {{ role: "system" | "user", content: string }[]}
 */
export function buildSummaryMessages(transcript) {
  return [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: buildSummaryUserPrompt(transcript) },
  ];
}
