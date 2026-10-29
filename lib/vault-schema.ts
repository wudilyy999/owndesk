// Field validation, Luhn, brands and hints adapted from the pinned MIT upstream lib/vault.ts (MIT).
import { z } from "zod"
import { HttpError } from "@/lib/errors"
import { paymentBindingSchema } from "@/lib/payment-schema"

export const vaultKinds = ["card", "upi", "login", "identity", "code"] as const
export type VaultKind = (typeof vaultKinds)[number]

export function normalizeVaultOrigin(input: string): string {
  const url = new URL(input)
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "请填写完整 HTTPS 站点地址，不含路径、账号或查询参数；HTTP 仅允许本机测试。"
    )
  return url.origin
}
export const vaultOriginSchema = z
  .string()
  .trim()
  .max(2048)
  .transform((value, ctx) => {
    try {
      return normalizeVaultOrigin(value)
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "请填写完整 HTTPS 站点地址，不含路径、账号或查询参数；HTTP 仅允许本机测试。",
      })
      return z.NEVER
    }
  })
const optional = z.string().trim().max(200).optional().default("")
function digits(value: string) {
  return value.replace(/\D/g, "")
}
function luhn(number: string) {
  let sum = 0,
    double = false
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = Number(number[i])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}
export const vaultInputSchemas = {
  card: z.strictObject({
    number: z
      .string()
      .regex(/^[\d -]{12,40}$/, "请核对卡号。")
      .transform(digits)
      .refine((n) => n.length >= 12 && n.length <= 19 && luhn(n), "请核对卡号。"),
    expiry: z
      .string()
      .trim()
      .regex(/^(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})$/, "有效期格式为 MM/YY。")
      .transform((value) => {
        const [m, y] = value.split("/").map((p) => p.trim())
        return `${m}/${y.slice(-2)}`
      }),
    name: optional,
  }),
  upi: z.strictObject({
    id: z
      .string()
      .trim()
      .max(320)
      .regex(/^[\w.-]{2,}@[a-z][\w.-]+$/i, "UPI 格式为 name@bank。"),
  }),
  login: z.strictObject({
    username: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(1000),
  }),
  identity: z
    .strictObject({
      name: optional,
      email: optional,
      phone: optional,
      address_line1: optional,
      address_line2: optional,
      city: optional,
      state: optional,
      postcode: optional,
      country: optional,
    })
    .refine((fields) => Object.values(fields).some(Boolean), "请至少填写一项资料。"),
  code: z.strictObject({ code: z.string().trim().min(3).max(32) }),
} satisfies Record<VaultKind, z.ZodType>

export const VAULT_FIELDS: Record<VaultKind, readonly string[]> = {
  card: ["number", "expiry", "expiry_month", "expiry_year", "expiry_year_short", "name"],
  upi: ["id"],
  login: ["username", "password"],
  code: ["code"],
  identity: [
    "name",
    "email",
    "phone",
    "address",
    "address_line1",
    "address_line2",
    "city",
    "state",
    "postcode",
    "country",
  ],
}
function brand(number: string) {
  if (/^4/.test(number)) return "Visa"
  if (/^(5[1-5]|2(2[2-9]|[3-6]|7[01]|720))/.test(number)) return "Mastercard"
  if (/^3[47]/.test(number)) return "Amex"
  if (/^(60|65|81|82|508|353|356)/.test(number)) return "RuPay"
  if (/^6(011|4[4-9])/.test(number)) return "Discover"
  return "Card"
}
function maskHandle(value: string) {
  if (value.includes("@")) {
    const [user, domain] = value.split("@")
    return `${user.slice(0, 1)}•••@${domain}`
  }
  const numbers = digits(value)
  return numbers.length >= 7 ? `•••• ${numbers.slice(-4)}` : `${value.slice(0, 2)}•••`
}
export function vaultHint(kind: VaultKind, fields: Record<string, string>): string {
  switch (kind) {
    case "card":
      return `${brand(fields.number)} ···· ${fields.number.slice(-4)} · ${fields.expiry}`
    case "upi":
      return `UPI ${maskHandle(fields.id)}`
    case "login":
      return maskHandle(fields.username)
    case "identity":
      return "身份资料（已加密）"
    case "code":
      return "一次性验证码"
  }
}
export function vaultFieldValues(
  kind: VaultKind,
  fields: Record<string, string>,
  names: string[]
) {
  const [month, year] = (fields.expiry ?? "").split("/")
  const derived: Record<string, string> = {
    expiry_month: month,
    expiry_year: year ? `20${year}` : "",
    expiry_year_short: year,
    address: [
      fields.address_line1,
      fields.address_line2,
      fields.city,
      fields.state,
      fields.postcode,
      fields.country,
    ]
      .filter(Boolean)
      .join(", "),
  }
  return names.map((field) => {
    if (!VAULT_FIELDS[kind].includes(field))
      throw new HttpError(400, "条目不支持指定字段。")
    const value = fields[field] || derived[field]
    if (!value)
      throw new HttpError(409, "条目没有保存指定字段。请补全资料后重新申请填写。")
    return { field, value }
  })
}
export const vaultMutationSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  kind: z.enum(vaultKinds),
  origin: vaultOriginSchema,
  label: z.string().trim().max(60),
  fields: z.record(z.string(), z.unknown()),
})
export type VaultMutation = z.infer<typeof vaultMutationSchema>
export type VaultItemView = {
  id: string
  kind: VaultKind
  label: string
  hint: string
  origin: string | null
  revision: number
  ephemeral: boolean
  expiresAt: string | null
  consumedAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

const fillField = z.enum([
  "username",
  "password",
  "code",
  "name",
  "email",
  "phone",
  "address",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postcode",
  "country",
  "number",
  "expiry",
  "expiry_month",
  "expiry_year",
  "expiry_year_short",
  "id",
])
const fillBinding = z.strictObject({ field: fillField, ref: z.string().regex(/^r\d+$/) })
export const vaultFillInputSchema = z
  .strictObject({
    itemId: z.string().min(1).max(200),
    revision: z.number().int().min(1),
    pageId: z.uuid(),
    observationId: z.uuid(),
    fields: z.array(fillBinding).min(1).max(10),
    paymentRequestId: z.string().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.fields.some((f) =>
        [
          "number",
          "expiry",
          "expiry_month",
          "expiry_year",
          "expiry_year_short",
          "id",
        ].includes(f.field)
      ) &&
      !value.paymentRequestId
    )
      ctx.addIssue({
        code: "custom",
        message: "Payment fields require a paymentRequestId and separate owner approval.",
      })
    if (
      new Set(value.fields.map((f) => f.field)).size !== value.fields.length ||
      new Set(value.fields.map((f) => f.ref)).size !== value.fields.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Each field and target reference must appear once.",
      })
  })
export type VaultFillInput = z.infer<typeof vaultFillInputSchema>
const descriptorSchema = z.strictObject({
  tag: z.enum(["input", "textarea"]),
  type: z.string().max(40),
  name: z.string().max(200),
  autocomplete: z.string().max(100),
})
export const vaultInspectionSchema = z.strictObject({
  origin: z.string(),
  epoch: z.number().int().nonnegative(),
  bootId: z.uuid(),
  fields: z
    .array(fillBinding.extend({ descriptor: descriptorSchema }))
    .min(1)
    .max(10),
})
export const vaultGrantSchema = vaultInspectionSchema
  .extend({
    purpose: z.literal("vault_fill"),
    itemId: z.string().min(1).max(200),
    revision: z.number().int().min(1),
    kind: z.enum(vaultKinds),
    label: z.string(),
    hint: z.string(),
    agentId: z.string(),
    segmentNo: z.number().int().min(1),
    actionNo: z.number().int().min(1),
    pageId: z.uuid(),
    observationId: z.uuid(),
    expiresAt: z.iso.datetime(),
    payment: paymentBindingSchema.optional(),
  })
  .superRefine((grant, ctx) => {
    if (["card", "upi"].includes(grant.kind) !== !!grant.payment)
      ctx.addIssue({
        code: "custom",
        message: "Payment binding is required exactly for card/UPI filling.",
      })
  })
export type VaultGrant = z.infer<typeof vaultGrantSchema>
export const vaultFillReceiptSchema = z.strictObject({
  origin: z.string(),
  filled: z.array(fillField).max(10),
  attempted: z.array(fillField).max(10),
  stage: z.enum(["preflight", "fill", "done"]),
})
