import assert from "node:assert/strict"
import test from "node:test"
import { chunkText } from "@/lib/channels/types"
import {
  parseQqPayload,
  qqRoute,
  qqSignValidation,
  qqVerifyCallback,
  sanitizeQqText,
  wakeupPeriod,
  QQ_MAX_PASSIVE_REPLIES,
} from "@/lib/channels/qq"
import {
  oaDecrypt,
  oaEncrypt,
  oaVerifySignature,
  parseOaMessage,
} from "@/lib/channels/wechat-oa"
import { wechatMessageText } from "@/lib/channels/wechat"
import { PAIR_PATTERN } from "@/lib/channels/pairing"
import { renderMessage } from "@/lib/channels/hub"

// Official QQ docs sample: secret, event_ts, plain_token -> signature
const SECRET = "DG5g3B4j9X2KOErG"
const SAMPLE =
  "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706"

test("QQ address validation matches the official sample", () => {
  assert.equal(qqSignValidation(SECRET, "1725442341", "Arq0D5A61EgUu4OxUvOp"), SAMPLE)
})

test("QQ callback signatures: valid, tampered, malformed", () => {
  const body = '{"op":0,"t":"C2C_MESSAGE_CREATE"}'
  const signature = qqSignValidation(SECRET, "1700000000", body)
  assert.equal(qqVerifyCallback(SECRET, "1700000000", signature, body), true)
  assert.equal(qqVerifyCallback(SECRET, "1700000001", signature, body), false)
  assert.equal(qqVerifyCallback(SECRET, "1700000000", signature, body + " "), false)
  assert.equal(
    qqVerifyCallback("another-secret-value", "1700000000", signature, body),
    false
  )
  assert.equal(qqVerifyCallback(SECRET, "1700000000", "zz", body), false)
  assert.equal(qqVerifyCallback(SECRET, null, signature, body), false)
})

test("QQ wake-up periods follow the UTC+8 calendar day", () => {
  const now = new Date("2026-11-01T02:00:00Z")
  const ago = (iso: string) => wakeupPeriod(new Date(iso), now)
  assert.equal(ago("2026-10-31T17:00:00Z"), 0) // 01:00 on 11-01 UTC+8: same day
  assert.equal(ago("2026-10-31T15:00:00Z"), 1) // 23:00 on 10-31 UTC+8 is the day before
  assert.equal(ago("2026-10-30T02:00:00Z"), 1) // 2 days
  assert.equal(ago("2026-10-28T02:00:00Z"), 2)
  assert.equal(ago("2026-10-20T02:00:00Z"), 3)
  assert.equal(ago("2026-10-02T02:00:00Z"), null) // 30 days
  assert.equal(wakeupPeriod(null, now), null)
})

test("QQ routing: passive while fresh, then one wake-up per period, never after rejection", () => {
  const now = new Date("2026-11-01T02:00:00Z")
  const base = { lastInboundAt: new Date("2026-11-01T01:58:00Z") }
  const fresh = qqRoute(
    { ...base, state: { msgId: "m", msgIdAt: "2026-11-01T01:58:00Z", seq: 1 } },
    now
  )
  assert.deepEqual(fresh, { type: "passive", msgId: "m", seq: 2 })
  const spent = qqRoute(
    {
      ...base,
      state: { msgId: "m", msgIdAt: "2026-11-01T01:58:00Z", seq: QQ_MAX_PASSIVE_REPLIES },
    },
    now
  )
  assert.equal(spent.type, "wakeup")
  const stale = { msgId: "m", msgIdAt: "2026-11-01T01:00:00Z", seq: 0 }
  assert.equal(qqRoute({ ...base, state: stale }, now).type, "wakeup")
  assert.equal(
    qqRoute(
      {
        ...base,
        state: {
          ...stale,
          anchorDay: "2026-11-01",
          wakeupUsed: [true, false, false, false],
        },
      },
      now
    ).type,
    "none"
  )
  assert.equal(
    qqRoute({ ...base, state: { ...stale, rejected: true } }, now).type,
    "none"
  )
  assert.equal(
    qqRoute({ lastInboundAt: new Date("2026-09-01T00:00:00Z"), state: {} }, now).type,
    "none"
  )
})

test("QQ text: unregistered links are replaced; payloads are normalised", () => {
  assert.equal(
    sanitizeQqText("看 https://ok.example.com/a 还有 https://no.example.org", [
      "ok.example.com",
    ]),
    "看 https://ok.example.com/a 还有 （链接在网页里）"
  )
  const event = parseQqPayload({
    id: "e1",
    op: 0,
    t: "C2C_MESSAGE_CREATE",
    d: { id: "m1", content: " 你好 ", author: { user_openid: "OID" } },
  })
  assert.deepEqual(event, {
    type: "message",
    eventKey: "e1",
    openid: "OID",
    text: "你好",
    context: { msgId: "m1" },
  })
  assert.equal(parseQqPayload({ op: 11 }), null)
  assert.deepEqual(parseQqPayload({ op: 0, t: "C2C_MSG_REJECT", d: { openid: "OID" } }), {
    type: "reject",
    openid: "OID",
  })
})

test("chunkText cuts at line breaks and keeps everything", () => {
  const text = ["一".repeat(30), "二".repeat(30), "三".repeat(30)].join("\n")
  const parts = chunkText(text, 40)
  assert.equal(parts.join("\n"), text)
  assert.ok(parts.every((part) => part.length <= 40))
})

test("WeChat official account: signature, AES round trip, XML parsing", () => {
  const key = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
  const xml = "<xml><FromUserName><![CDATA[u]]></FromUserName></xml>"
  const cipher = oaEncrypt(key, xml, "wxapp")
  assert.equal(oaDecrypt(key, cipher, "wxapp"), xml)
  assert.throws(() => oaDecrypt(key, cipher, "wxother"))
  assert.equal(oaVerifySignature("t", "bad", "1", "2"), false)
  assert.equal(oaVerifySignature("t", null, "1", "2"), false)
  const message = parseOaMessage(
    "<xml><FromUserName><![CDATA[openid]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>77</MsgId></xml>"
  )
  assert.deepEqual(message, { openid: "openid", eventKey: "77", text: "你好" })
  assert.match(
    parseOaMessage(
      "<xml><FromUserName>o</FromUserName><MsgType>image</MsgType><MsgId>1</MsgId></xml>"
    )!.text,
    /看不到/
  )
})

test("WeChat ClawBot text extraction (text, voice transcript, other)", () => {
  assert.equal(
    wechatMessageText({ item_list: [{ type: 1, text_item: { text: "嗨" } }] }),
    "嗨"
  )
  assert.equal(
    wechatMessageText({ item_list: [{ type: 3, voice_item: { text: "语音转文字" } }] }),
    "语音转文字"
  )
  assert.match(wechatMessageText({ item_list: [{ type: 2 }] }), /看不到/)
})

test("binding needs the keyword, so ordinary words are never taken for codes", () => {
  assert.equal(PAIR_PATTERN.exec("绑定 ABCD2345")?.[1], "ABCD2345")
  assert.equal(PAIR_PATTERN.exec("/bind abcd2345")?.[1], "abcd2345")
  assert.equal(PAIR_PATTERN.exec("computer"), null)
  assert.equal(PAIR_PATTERN.exec("ABCD2345"), null)
})

test("only chat-like messages go to channels; cards stay on the web", () => {
  assert.equal(renderMessage({ kind: "chat", content: "嗨", metadata: null }), "嗨")
  assert.equal(
    renderMessage({ kind: "memory_candidate", content: "x", metadata: null }),
    null
  )
  assert.match(
    renderMessage({
      kind: "errand_proposal",
      content: "x",
      metadata: { goal: "查天气" },
    })!,
    /网页聊天页.*确认/
  )
})
