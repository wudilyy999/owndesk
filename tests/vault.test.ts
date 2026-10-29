import assert from "node:assert/strict"
import test from "node:test"
import { encryptSecret, decryptSecret } from "@/lib/secrets"
import {
  normalizeVaultOrigin,
  vaultInputSchemas,
  vaultHint,
  vaultFieldValues,
  vaultMutationSchema,
  vaultFillInputSchema,
  vaultGrantSchema,
  vaultFillReceiptSchema,
} from "@/lib/vault-schema"
import { z } from "zod"
import { HttpError } from "@/lib/errors"

test("identity reference batches accept ten distinct fields including long derived addresses; missing optional values reject before release", () => {
  const fields = vaultInputSchemas.identity.parse({
    name: "Sample",
    email: "sample@example.test",
    phone: "Sample phone",
    address_line1: "a".repeat(200),
    address_line2: "b".repeat(200),
    city: "c".repeat(200),
    state: "s".repeat(200),
    postcode: "p".repeat(200),
    country: "n".repeat(200),
  })
  const names = [
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
  ]
  const input = {
    itemId: "identity",
    revision: 1,
    pageId: "a28a1b69-f87a-4ddc-8fa2-2e86ffcd02cb",
    observationId: "e09a805f-ed2a-4be0-bf94-d582a77312b3",
    fields: names.map((field, index) => ({ field, ref: `r${index}` })),
  }
  assert.equal(vaultFillInputSchema.parse(input).fields.length, 10)
  const values = vaultFieldValues("identity", fields, names)
  assert.equal(values[3].value.length, 1210)
  assert.equal(vaultHint("identity", fields), "身份资料（已加密）")
  assert.throws(
    () => vaultFieldValues("identity", { name: "Sample" }, ["name", "email"]),
    (error) =>
      error instanceof HttpError &&
      error.status === 409 &&
      !error.message.includes("Sample")
  )
  for (const field of ["number", "id", "cvv"])
    assert.throws(() =>
      vaultFillInputSchema.parse({ ...input, fields: [{ field, ref: "r1" }] })
    )
  assert.throws(() =>
    vaultFillInputSchema.parse({
      ...input,
      fields: [...input.fields, { field: "username", ref: "r11" }],
    })
  )
  assert.throws(() => vaultFieldValues("identity", fields, ["password"]))
})

test("bound vault envelopes require installation/row/type context, random IV and authenticated bytes; v1 service secrets remain compatible", () => {
  const value = "sample-vault-value",
    context = "vault-v2:installation:item:login"
  const encrypted = encryptSecret(value, context)
  assert.match(encrypted, /^v2:/)
  assert.notEqual(encrypted, encryptSecret(value, context))
  assert.equal(decryptSecret(encrypted, context), value)
  for (const other of [
    undefined,
    "vault-v2:other:item:login",
    "vault-v2:installation:other:login",
    "vault-v2:installation:item:code",
  ])
    assert.throws(() => decryptSecret(encrypted, other))
  const bytes = Buffer.from(encrypted.slice(3), "base64url")
  bytes[14] ^= 1
  assert.throws(() => decryptSecret(`v2:${bytes.toString("base64url")}`, context))
  const old = encryptSecret(value)
  assert.match(old, /^v1:/)
  assert.equal(decryptSecret(old), value)
  assert.throws(() => decryptSecret(old, context))
})

test("fill input is reference-only, unique per field/target; grant and safe receipt schemas reject extra values", () => {
  const input = {
    itemId: "sample-item",
    revision: 2,
    pageId: "a28a1b69-f87a-4ddc-8fa2-2e86ffcd02cb",
    observationId: "e09a805f-ed2a-4be0-bf94-d582a77312b3",
    fields: [
      { field: "username", ref: "r1" },
      { field: "password", ref: "r2" },
    ],
  }
  assert.deepEqual(vaultFillInputSchema.parse(input), input)
  assert.throws(() => vaultFillInputSchema.parse({ ...input, text: "secret" }))
  assert.throws(() =>
    vaultFillInputSchema.parse({ ...input, fields: [input.fields[0], input.fields[0]] })
  )
  assert.throws(() =>
    vaultFillInputSchema.parse({
      ...input,
      fields: [
        { field: "username", ref: "r1" },
        { field: "password", ref: "r1" },
      ],
    })
  )
  assert.throws(() =>
    vaultFillReceiptSchema.parse({
      origin: "https://example.test",
      filled: ["password"],
      attempted: ["password"],
      stage: "done",
      value: "secret",
    })
  )
  assert.throws(() => vaultGrantSchema.parse({ ...input, purpose: "vault_fill" }))
  assert(z.toJSONSchema(vaultFillInputSchema).properties)
})
test("exact origins reject unsafe protocols, public HTTP, credentials, paths and queries; preserve protocol/host/port", () => {
  assert.equal(
    normalizeVaultOrigin("https://REPORTS.example.test:443/"),
    "https://reports.example.test"
  )
  assert.equal(normalizeVaultOrigin("http://127.0.0.1:8082"), "http://127.0.0.1:8082")
  assert.notEqual(
    normalizeVaultOrigin("https://a.example.test"),
    normalizeVaultOrigin("https://example.test")
  )
  for (const value of [
    "https://example.test@other.test/login",
    "http://example.test",
    "file:///tmp/x",
    "https://a.example.test/path",
    "https://a.example.test?key=x",
    "https://a.example.test#x",
    "example.test",
  ])
    assert.throws(() => normalizeVaultOrigin(value))
})
test("retained five-kind validation, derived fields and masked hints reject CVV/unknown fields and empty identity", () => {
  const card = vaultInputSchemas.card.parse({
    number: "4242 4242 4242 4242",
    expiry: "08/2029",
  })
  assert.equal(card.number, "4242424242424242")
  assert.equal(card.expiry, "08/29")
  assert.equal(vaultHint("card", card), "Visa ···· 4242 · 08/29")
  assert.deepEqual(vaultFieldValues("card", card, ["expiry_month", "expiry_year"]), [
    { field: "expiry_month", value: "08" },
    { field: "expiry_year", value: "2029" },
  ])
  assert.throws(() => vaultInputSchemas.card.parse({ ...card, cvv: "123" }))
  assert.throws(() =>
    vaultInputSchemas.card.parse({ number: "1111111111111111", expiry: "19/29" })
  )
  assert.throws(() => vaultInputSchemas.identity.parse({}))
  assert.throws(() =>
    vaultFieldValues("login", { username: "u", password: "p" }, ["cvv"])
  )
  assert.equal(
    vaultHint("login", { username: "owner@example.test" }),
    "o•••@example.test"
  )
  assert.equal(vaultInputSchemas.upi.parse({ id: "owner@bank" }).id, "owner@bank")
  assert.equal(vaultInputSchemas.code.parse({ code: "123456" }).code, "123456")
  assert.equal(
    vaultInputSchemas.identity.parse({ name: "Sample name" }).name,
    "Sample name"
  )
  assert.throws(() =>
    vaultMutationSchema.parse({
      id: "bad/id",
      kind: "login",
      origin: "https://example.test",
      label: "x",
      fields: {},
    })
  )
  assert.equal(
    vaultMutationSchema.parse({
      id: "legacy_12-id",
      kind: "login",
      origin: "https://example.test",
      label: "",
      fields: {},
    }).id,
    "legacy_12-id"
  )
})
