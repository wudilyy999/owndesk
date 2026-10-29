import assert from "node:assert/strict"
import test from "node:test"
import { encryptSecret, decryptSecret } from "@/lib/secrets"
import { taskInputSchema } from "@/db/schema"

test("secret encryption is randomized and rejects modified ciphertext", () => {
  const secret = "test-only-token"
  const a = encryptSecret(secret),
    b = encryptSecret(secret)
  assert.notEqual(a, b)
  assert.equal(decryptSecret(a), secret)
  const corrupted = Buffer.from(a.slice(3), "base64url")
  corrupted[corrupted.length - 1] ^= 1
  assert.throws(() => decryptSecret(`v1:${corrupted.toString("base64url")}`))
})

test("task boundary validates and normalizes the request", () => {
  const input = taskInputSchema.parse({
    agentId: "agent",
    goal: "  report  ",
    clientRequestId: "request",
  })
  assert.equal(input.goal, "report")
  assert.equal(input.budget.maxSteps, 40)
  assert.equal(input.completionContract.requireHumanReview, false)
  assert.throws(() => taskInputSchema.parse({ ...input, goal: " " }))
  assert.throws(() => taskInputSchema.parse({ ...input, budget: { maxSteps: 0 } }))
})
