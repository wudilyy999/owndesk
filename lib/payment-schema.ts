import { z } from "zod"

const textRef = z.string().regex(/^t\d+$/)
export const paymentInputSchema = z.strictObject({
  merchant: z.string().trim().min(1).max(500),
  amount: z.string().trim().min(1).max(500),
  purpose: z.string().trim().min(1).max(1000),
  pageId: z.uuid(),
  observationId: z.uuid(),
  evidenceRefs: z
    .strictObject({ merchant: textRef, amount: textRef })
    .refine(
      (value) => value.merchant !== value.amount,
      "Merchant and amount require separate visible text references."
    ),
})
export type PaymentInput = z.infer<typeof paymentInputSchema>
const textEvidence = z.strictObject({
  ref: textRef,
  tag: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .max(40),
  text: z.string().min(1).max(500),
})
export const paymentEvidenceSchema = z.strictObject({
  merchant: textEvidence,
  amount: textEvidence,
})
export const paymentInspectionSchema = z.strictObject({
  origin: z.string(),
  epoch: z.number().int().nonnegative(),
  bootId: z.uuid(),
  evidence: paymentEvidenceSchema,
})
export const paymentMethodSchema = z.strictObject({
  id: z.string().min(1).max(200),
  revision: z.number().int().positive(),
  kind: z.enum(["card", "upi"]),
  label: z.string(),
  hint: z.string(),
})
export const paymentApprovalSchema = paymentInspectionSchema.extend({
  purpose: z.literal("payment"),
  merchant: z.string(),
  amount: z.string(),
  reason: z.string(),
  pageId: z.uuid(),
  observationId: z.uuid(),
  agentId: z.string(),
  segmentNo: z.number().int().positive(),
  actionNo: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  methods: z.array(paymentMethodSchema),
})
export type PaymentApproval = z.infer<typeof paymentApprovalSchema>
export const paymentBindingSchema = z.strictObject({
  requestId: z.string().min(1).max(200),
  merchant: z.string(),
  amount: z.string(),
  evidence: paymentEvidenceSchema,
})
export const paymentChoiceSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("select"),
    payloadVersion: z.number().int().positive(),
    itemId: z.string().min(1).max(200),
    revision: z.number().int().positive(),
  }),
  z.strictObject({
    action: z.literal("takeover"),
    payloadVersion: z.number().int().positive(),
  }),
])
export function normalizePaymentText(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

export const paymentSubmitInputSchema = z.strictObject({
  paymentRequestId: z.string().min(1).max(200),
  pageId: z.uuid(),
  observationId: z.uuid(),
  ref: z.string().regex(/^r\d+$/),
  evidenceRefs: paymentInputSchema.shape.evidenceRefs,
})
export type PaymentSubmitInput = z.infer<typeof paymentSubmitInputSchema>
export const paymentTargetSchema = z.strictObject({
  tag: z.enum(["button", "input"]),
  type: z.enum(["button", "submit"]),
  label: z.string().min(1).max(200),
  formAction: z.string().max(2048),
  formMethod: z.enum(["", "get", "post"]),
})
export const paymentSubmitInspectionSchema = paymentInspectionSchema.extend({
  target: paymentTargetSchema,
})
export const paymentSubmitGrantSchema = paymentSubmitInspectionSchema.extend({
  purpose: z.literal("payment_submit"),
  submissionRequestId: z.string(),
  paymentRequestId: z.string(),
  merchant: z.string(),
  amount: z.string(),
  method: paymentMethodSchema,
  pageId: z.uuid(),
  observationId: z.uuid(),
  ref: z.string().regex(/^r\d+$/),
  agentId: z.string(),
  segmentNo: z.number().int().positive(),
  actionNo: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
})
export type PaymentSubmitGrant = z.infer<typeof paymentSubmitGrantSchema>
export const paymentSubmitReceiptSchema = z.strictObject({
  clicked: z.literal(true),
  origin: z.string(),
  submissionRequestId: z.string(),
  verification: z.literal("dispatch_only"),
})
export const paymentResultInputSchema = z.strictObject({
  submissionRequestId: z.string().min(1).max(200),
  pageId: z.uuid(),
  observationId: z.uuid(),
  evidenceRefs: z
    .strictObject({
      merchant: textRef,
      amount: textRef,
      status: textRef,
      receipt: textRef,
    })
    .refine(
      (refs) => new Set(Object.values(refs)).size === 4,
      "Result evidence needs four distinct visible text references."
    ),
})
export type PaymentResultInput = z.infer<typeof paymentResultInputSchema>
export const paymentResultReceiptSchema = paymentInspectionSchema.extend({
  submissionRequestId: z.string(),
  verification: z.literal("page_text_only"),
  evidence: paymentEvidenceSchema.extend({ status: textEvidence, receipt: textEvidence }),
})
export type PaymentResultReceipt = z.infer<typeof paymentResultReceiptSchema>
