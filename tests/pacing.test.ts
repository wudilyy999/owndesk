import assert from "node:assert/strict"
import test from "node:test"
import { playbackSchedule, realSleep, typingDelay } from "@/lib/companion/pacing"
import { splitBubbles } from "@/lib/companion/chat"

const mid = () => 0.5

test("playback waits for its deadline after an early timer or backward clock adjustment", async (t) => {
  let now = 1000
  const timers: { callback: () => void; ms: number }[] = []
  t.mock.method(Date, "now", () => now)
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => {
    timers.push({ callback, ms })
    return 1
  })
  let finished = false
  const wait = realSleep(100).then(() => {
    finished = true
  })
  assert.equal(timers[0].ms, 100)
  now = 1099
  timers.shift()!.callback()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(finished, false, "an early timer cannot reveal a future bubble")
  assert.equal(timers[0].ms, 1)
  now = 1000
  timers.shift()!.callback()
  await Promise.resolve()
  assert.equal(finished, false, "a backward wall clock must extend the wait")
  assert.equal(timers[0].ms, 100)
  now = 1100
  timers.shift()!.callback()
  await wait
  assert.equal(finished, true)
  assert.equal(timers.length, 0)
  await realSleep(0)
  await realSleep(-1)
  assert.equal(timers.length, 0, "already due bubbles need no timer")
})

test("typing delay grows with length, has jitter, and is zero when switched off", () => {
  assert.equal(typingDelay("好", "off", mid), 0)
  const short = typingDelay("好", "natural", mid)
  const long = typingDelay("好".repeat(30), "natural", mid)
  assert.ok(short >= 400 && short < long)
  assert.ok(long <= 3500, "one bubble is never typed for longer than the cap")
  assert.notEqual(
    typingDelay("你好呀", "natural", () => 0),
    typingDelay("你好呀", "natural", () => 1)
  )
  assert.equal(
    typingDelay("你好呀", "natural", () => 0.5),
    Math.round((400 + 60 * 3) * 1)
  )
  assert.ok(
    typingDelay("一二三四五六七八九十", "fast", mid) <
      typingDelay("一二三四五六七八九十", "natural", mid)
  )
})

test("a schedule is increasing, starts quickly, and stays inside the total cap", () => {
  assert.deepEqual(playbackSchedule(["a", "b"], "off", mid), [0, 0])
  assert.deepEqual(playbackSchedule([], "natural", mid), [])
  const long = "字".repeat(60)
  const schedule = playbackSchedule([long, long, long, long, long], "natural", mid)
  assert.ok(schedule[0] <= 1500, "the first bubble waits at most 1.5 s")
  for (let i = 1; i < schedule.length; i++) assert.ok(schedule[i] > schedule[i - 1])
  assert.ok(schedule.at(-1)! <= 8000 + schedule.length, "whole reply about 8 s at most")
  const fast = playbackSchedule([long, long, long, long, long], "fast", mid)
  assert.ok(fast.at(-1)! <= 3500 + fast.length)
  assert.ok(fast.at(-1)! < schedule.at(-1)!)
})

test("bubbles from a real split get one moment each", () => {
  const bubbles = splitBubbles("嗯\n\n刚下班\n\n你呢")
  assert.equal(bubbles.length, 3)
  const schedule = playbackSchedule(bubbles, "natural", mid)
  assert.equal(new Set(schedule).size, 3)
})
