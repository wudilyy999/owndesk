import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { TaskRequest } from "@/components/task-request"
import {
  paymentInputSchema,
  paymentChoiceSchema,
  paymentMethodSchema,
  normalizePaymentText,
  paymentSubmitInputSchema,
  paymentResultInputSchema,
  paymentSubmitReceiptSchema,
} from "@/lib/payment-schema"
import { PaymentResultEvidence } from "@/components/vault/payment-submit"
import { vaultFillInputSchema, vaultGrantSchema } from "@/lib/vault-schema"

const pageId = "a28a1b69-f87a-4ddc-8fa2-2e86ffcd02cb"
const observationId = "e09a805f-ed2a-4be0-bf94-d582a77312b3"
test("submission accepts only references; result evidence stays distinct from payment settlement", () => {
  const input = {
    paymentRequestId: "choice",
    pageId,
    observationId,
    ref: "r2",
    evidenceRefs: { merchant: "t1", amount: "t2" },
  }
  assert.deepEqual(paymentSubmitInputSchema.parse(input), input)
  assert.throws(() => paymentSubmitInputSchema.parse({ ...input, amount: "USD 1" }))
  assert.throws(() => paymentSubmitInputSchema.parse({ ...input, approved: true }))
  const result = {
    submissionRequestId: "submit",
    pageId,
    observationId,
    evidenceRefs: { merchant: "t1", amount: "t2", status: "t3", receipt: "t4" },
  }
  assert.deepEqual(paymentResultInputSchema.parse(result), result)
  assert.throws(() =>
    paymentResultInputSchema.parse({
      ...result,
      evidenceRefs: { ...result.evidenceRefs, receipt: "t3" },
    })
  )
  assert.throws(() => paymentSubmitReceiptSchema.parse({ clicked: true, paid: true }))
  const html = renderToStaticMarkup(
    createElement(PaymentResultEvidence, {
      result: {
        submissionRequestId: "submit",
        origin: "https://fixture.test",
        epoch: 1,
        bootId: pageId,
        verification: "page_text_only",
        evidence: {
          merchant: { ref: "t1", tag: "h2", text: "Fixture Store" },
          amount: { ref: "t2", tag: "p", text: "USD 12.00" },
          status: { ref: "t3", tag: "p", text: "Fixture recorded" },
          receipt: { ref: "t4", tag: "p", text: "fixture-order-1" },
        },
      },
    })
  )
  assert(html.includes("尚未独立核销"))
  assert(html.includes("fixture-order-1"))
  assert(html.includes("不证明银行已扣款"))
})
test("partial payment review names filled fields in user language and keeps only continue/cancel decisions", () => {
  const html = renderToStaticMarkup(
    createElement(TaskRequest, {
      request: {
        id: "review",
        kind: "review",
        status: "pending",
        payloadVersion: 1,
        payload: {
          tool: "vault_fill",
          details: { filled: ["number"], attempted: ["number", "expiry"] },
          reason: "需要核对部分填写",
        },
      },
      busy: false,
      onRespond: () => {},
    })
  )
  assert(html.includes("卡号"))
  assert(html.includes("有效期"))
  assert(!html.includes("确认完成"))
  assert(html.includes("继续处理"))
})
test("payment proposals bind distinct current text refs, keep currency text literal and never accept secret choice fields", () => {
  const proposal = {
    merchant: "Fixture Store",
    amount: "USD 1,234.50",
    purpose: "Prepare checkout",
    pageId,
    observationId,
    evidenceRefs: { merchant: "t1", amount: "t2" },
  }
  assert.deepEqual(paymentInputSchema.parse(proposal), proposal)
  assert.throws(() =>
    paymentInputSchema.parse({
      ...proposal,
      evidenceRefs: { merchant: "t1", amount: "t1" },
    })
  )
  assert.throws(() => paymentInputSchema.parse({ ...proposal, amount: 1234.5 }))
  assert.throws(() =>
    paymentInputSchema.parse({
      ...proposal,
      evidenceRefs: { merchant: "r1", amount: "r2" },
    })
  )
  assert.equal(normalizePaymentText("  USD\n  1,234.50 "), "USD 1,234.50")
  assert.notEqual(
    normalizePaymentText("USD 1,234.50"),
    normalizePaymentText("USD 1234.50")
  )
  assert.deepEqual(paymentChoiceSchema.parse({ action: "takeover", payloadVersion: 1 }), {
    action: "takeover",
    payloadVersion: 1,
  })
  for (const extra of [{ number: "sample" }, { cvv: "sample" }, { response: {} }])
    assert.throws(() =>
      paymentChoiceSchema.parse({
        action: "select",
        payloadVersion: 1,
        itemId: "saved-card",
        revision: 2,
        ...extra,
      })
    )
  assert.throws(() =>
    paymentMethodSchema.parse({
      id: "card",
      revision: 1,
      kind: "card",
      label: "x",
      hint: "masked",
      fields: { number: "sample" },
    })
  )
  assert(z.toJSONSchema(paymentInputSchema).properties)
})
test("payment filling remains reference-only and requires a payment binding exactly for card/UPI grants", () => {
  const input = {
    itemId: "card",
    revision: 1,
    pageId,
    observationId,
    fields: [{ field: "number", ref: "r1" }],
  }
  assert.throws(() => vaultFillInputSchema.parse(input))
  assert.deepEqual(
    vaultFillInputSchema.parse({ ...input, paymentRequestId: "approval" }),
    { ...input, paymentRequestId: "approval" }
  )
  assert.throws(() =>
    vaultFillInputSchema.parse({ ...input, paymentRequestId: "approval", text: "sample" })
  )
  assert.throws(() =>
    vaultFillInputSchema.parse({
      ...input,
      paymentRequestId: "approval",
      fields: [{ field: "cvv", ref: "r1" }],
    })
  )
  const grant = {
    purpose: "vault_fill",
    ...input,
    kind: "card",
    label: "Card",
    hint: "masked",
    agentId: "agent",
    segmentNo: 1,
    actionNo: 2,
    origin: "https://checkout.test",
    epoch: 4,
    bootId: pageId,
    expiresAt: "2026-10-25T12:00:00.000Z",
    fields: [
      {
        field: "number",
        ref: "r1",
        descriptor: {
          tag: "input",
          type: "text",
          name: "number",
          autocomplete: "cc-number",
        },
      },
    ],
  }
  assert.throws(() => vaultGrantSchema.parse(grant))
  const payment = {
    requestId: "approval",
    merchant: "Store",
    amount: "USD 12.00",
    evidence: {
      merchant: { ref: "t1", tag: "h2", text: "Store" },
      amount: { ref: "t2", tag: "p", text: "USD 12.00" },
    },
  }
  assert.equal(vaultGrantSchema.parse({ ...grant, payment }).kind, "card")
  assert.throws(() => vaultGrantSchema.parse({ ...grant, kind: "identity", payment }))
})
