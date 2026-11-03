// Typing rhythm: she types for a moment before each bubble, like a person sending several texts.
// The model reply is generated in one go; only the playback is paced (web SSE, channel outbox).
// Rhythm numbers are our own (design: docs/companion-stage-b1.md); no code taken from other projects.
import { and, isNull, lte, or } from "drizzle-orm"
import { companionMessages } from "@/db/schema"

export type TypingPace = "natural" | "fast" | "off"
export const TYPING_PACES: TypingPace[] = ["natural", "fast", "off"]

const PROFILE: Record<
  Exclude<TypingPace, "off">,
  { base: number; perChar: number; cap: number; first: number; total: number }
> = {
  // 0.4 s + 0.06 s per character, at most 3.5 s a bubble, about 8 s for the whole reply
  natural: { base: 400, perChar: 60, cap: 3500, first: 1500, total: 8000 },
  fast: { base: 200, perChar: 25, cap: 1500, first: 800, total: 3500 },
}

// Milliseconds she "types" before one bubble; `random` returns 0..1 (injectable for tests)
export function typingDelay(text: string, pace: TypingPace, random = Math.random) {
  if (pace === "off") return 0
  const profile = PROFILE[pace]
  const raw = Math.min(profile.cap, profile.base + profile.perChar * [...text].length)
  // ±20 % so two bubbles of the same length do not arrive on a metronome
  return Math.round(raw * (0.8 + 0.4 * random()))
}

// When each bubble appears, in ms after the reply is ready. The first bubble waits less (she has
// already been "thinking" while the model worked); the whole reply is capped.
export function playbackSchedule(
  bubbles: string[],
  pace: TypingPace,
  random = Math.random
) {
  if (pace === "off") return bubbles.map(() => 0)
  const profile = PROFILE[pace]
  const gaps = bubbles.map((text, index) =>
    Math.min(typingDelay(text, pace, random), index === 0 ? profile.first : profile.cap)
  )
  const sum = gaps.reduce((a, b) => a + b, 0)
  const scale = sum > profile.total ? profile.total / sum : 1
  let at = 0
  return gaps.map((gap) => (at += Math.round(gap * scale)))
}

// Messages that count as part of the conversation right now: not replaced, already revealed
export const visibleMessage = (now = new Date()) =>
  and(
    isNull(companionMessages.supersededAt),
    or(isNull(companionMessages.revealAt), lte(companionMessages.revealAt, now))
  )

export const realSleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
