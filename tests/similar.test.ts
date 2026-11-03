import assert from "node:assert/strict"
import { test } from "node:test"
import { findSimilar, proposeMerge, similarity } from "@/lib/companion/similar"

test("same fact in different words is similar", () => {
  assert.ok(similarity("喜欢吃辣", "爱吃辣的") >= 0.6)
  assert.ok(similarity("阿远喜欢吃辣", "喜欢吃辣的") >= 0.6)
  assert.ok(similarity("住在上海", "家在上海") >= 0.6)
  assert.equal(similarity("喜欢吃辣！", "喜欢吃辣"), 1)
})

test("different facts are not similar", () => {
  assert.ok(similarity("喜欢吃辣", "养了一只猫") < 0.3)
  assert.ok(similarity("喜欢猫", "喜欢狗") < 0.6)
  assert.ok(similarity("在上海工作", "在北京工作") < 0.6)
  assert.equal(similarity("", "喜欢吃辣"), 0)
})

test("findSimilar returns the closest notes first and respects the limit", () => {
  const notes = [
    { id: "a", content: "养了一只猫" },
    { id: "b", content: "喜欢吃辣" },
    { id: "c", content: "喜欢吃辣的火锅" },
  ]
  const hits = findSimilar("爱吃辣的", notes)
  assert.deepEqual(
    hits.map((hit) => hit.note.id),
    ["b", "c"]
  )
  assert.equal(findSimilar("爱吃辣的", notes, 1).length, 1)
  assert.deepEqual(findSimilar("今天下雨", notes), [])
})

test("proposeMerge keeps the fuller note, else the newer wording", () => {
  assert.equal(
    proposeMerge("喜欢吃辣", "阿远喜欢吃辣，尤其是火锅"),
    "阿远喜欢吃辣，尤其是火锅"
  )
  assert.equal(
    proposeMerge("阿远喜欢吃辣，尤其是火锅", "喜欢吃辣"),
    "阿远喜欢吃辣，尤其是火锅"
  )
  assert.equal(proposeMerge("住在上海", "搬到杭州了"), "搬到杭州了")
})
