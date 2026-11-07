import assert from "node:assert/strict"
import test from "node:test"
import { isRetriableModelError } from "@/lib/providers/fallback"
import { ModelConfigError } from "@/lib/providers/registry"

test("model fallback retries timeouts and 5xx, not bad keys or 4xx", () => {
  assert.equal(isRetriableModelError(new ModelConfigError("no key")), false)
  assert.equal(
    isRetriableModelError(Object.assign(new Error("bad"), { status: 401 })),
    false
  )
  assert.equal(
    isRetriableModelError(Object.assign(new Error("bad"), { status: 404 })),
    false
  )
  assert.equal(
    isRetriableModelError(Object.assign(new Error("busy"), { status: 429 })),
    true
  )
  assert.equal(
    isRetriableModelError(Object.assign(new Error("down"), { status: 503 })),
    true
  )
  assert.equal(
    isRetriableModelError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })),
    true
  )
  assert.equal(
    isRetriableModelError(Object.assign(new Error("x"), { name: "TimeoutError" })),
    true
  )
  assert.equal(isRetriableModelError(new Error("fetch failed")), true)
  assert.equal(isRetriableModelError(new Error("socket hang up")), true)
  assert.equal(isRetriableModelError(new Error("invalid json from model")), false)
})
assert.equal(
  isRetriableModelError(Object.assign(new Error("<none>"), { name: "AI_APICallError" })),
  true
)
assert.equal(
  isRetriableModelError(
    Object.assign(new Error("<none>"), { name: "AI_APICallError", status: 401 })
  ),
  false
)
