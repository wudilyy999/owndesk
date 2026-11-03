// Stage B2a against a throwaway database: similar-note confirm cards (merge / keep both / drop,
// never automatic) and pictures she is sent (storage, limits, description, sensitive-image memory rule).
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import pg from "pg"
import sharp from "sharp"
import { MockLanguageModelV3 } from "ai/test"

process.loadEnvFile(".env")
const database = `agent_companion_b2a_${randomUUID().replaceAll("-", "")}`
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
const artifacts = await mkdtemp(path.join(tmpdir(), "b2a-artifacts-"))
Object.assign(process.env, {
  ARTIFACT_DIR: artifacts,
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  OWNER_EMAIL: "b2a@fixture.test",
  OWNER_PASSWORD: randomUUID(),
})
let passed = false
try {
  const migration = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
  })
  await once(migration, "exit")
  assert.equal(migration.exitCode, 0)

  const { db, pool } = await import("@/db")
  const { closeDurableClient } = await import("@/lib/durable")
  const { companionChat } = await import("@/lib/companion/chat")
  const memory = await import("@/lib/companion/memory")
  const { listNotes } = memory
  const { updateCompanion, ensureCompanion } = await import("@/lib/companion/store")
  const { companionMessages } = await import("@/db/schema")
  const { asc, eq } = await import("drizzle-orm")

  const ownerId = "b2a-owner"
  const agentId = randomUUID()
  await pool.query(
    "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Taipei',now())",
    [ownerId]
  )
  await pool.query(
    "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'小满','Companion','fixture','custom/mock',now(),now())",
    [agentId]
  )
  await ensureCompanion(ownerId, agentId)
  await updateCompanion(ownerId, agentId, {
    rhythm: { sleep: { start: "03:00", end: "03:01" }, nap: null, away: [] },
  } as never)

  const scripted = (steps: Array<Array<Record<string, unknown>>>, seen?: string[]) => {
    let call = 0
    return new MockLanguageModelV3({
      doStream: async (options) => {
        seen?.push(JSON.stringify(options.prompt))
        const parts = steps[Math.min(call++, steps.length - 1)]
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] })
              for (const part of parts) controller.enqueue(part as never)
              controller.enqueue({
                type: "finish",
                finishReason: {
                  unified: parts.some((p) => p.type === "tool-call")
                    ? "tool-calls"
                    : "stop",
                  raw: undefined,
                },
                usage: {
                  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 20, text: 20, reasoning: 0 },
                },
              })
              controller.close()
            },
          }),
        }
      },
    })
  }
  const text = (value: string) => [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: value },
    { type: "text-end", id: "t" },
  ]
  const call = (name: string, input: unknown) => ({
    type: "tool-call",
    toolCallId: randomUUID(),
    toolName: name,
    input: JSON.stringify(input),
  })
  const price = {
    kind: "priced",
    source: "custom",
    price: { input: 1, output: 4 },
  } as const
  const broken = () =>
    new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("model is down")
      },
    })
  const rows = () =>
    db.select().from(companionMessages).orderBy(asc(companionMessages.createdAt))
  await updateCompanion(ownerId, agentId, { typingPace: "off" })

  // ───── similar notes ─────
  const run = (model: MockLanguageModelV3, textIn: string) =>
    companionChat({ ownerId, agentId, text: textIn }, { model, price })
  const note = await memory.addNote(agentId, "喜欢吃辣", "user")

  // 1. She wants to remember something that is the same as an existing note: no second note,
  //    a candidate plus a merge card instead
  const turn = await run(
    scripted([
      [call("remember", { note: "爱吃辣的", certainty: "sure" })],
      text("记住啦"),
    ]),
    "我超爱吃辣的"
  )
  const cards = turn.replies.filter((m) => m.kind === "memory_merge")
  assert.equal(cards.length, 1, "one merge card")
  assert.equal((cards[0].metadata as { status: string }).status, "pending")
  assert.equal((cards[0].metadata as { otherNote: string }).otherNote, "喜欢吃辣")
  assert.equal(
    (await listNotes(agentId, "active")).length,
    1,
    "nothing was merged by itself"
  )
  assert.equal((await listNotes(agentId, "candidate")).length, 1)
  assert.equal(turn.replies.filter((m) => m.kind === "memory_candidate").length, 0)
  const pending = await memory.listSuggestions(agentId)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].other.id, note.id)

  // 2. keep both: the candidate becomes a note, the pair is not offered again
  await memory.resolveSuggestion(agentId, pending[0].id, "keep")
  assert.equal((await listNotes(agentId, "active")).length, 2)
  assert.equal((await memory.listSuggestions(agentId)).length, 0)
  assert.equal(
    await memory.scanSimilar(agentId),
    0,
    "decided pair is not suggested again"
  )
  const kept = (await rows()).find((m) => m.kind === "memory_merge")!
  assert.equal((kept.metadata as { status: string }).status, "kept")

  // 3. merge: the older note takes the merged wording, the newer one is removed
  await pool.query("DELETE FROM memories")
  await pool.query("DELETE FROM companion_messages")
  const old = await memory.addNote(agentId, "住在上海", "user")
  const turn2 = await run(
    scripted([
      [call("remember", { note: "我住在上海浦东", certainty: "sure" })],
      text("好"),
    ]),
    "我我住在上海浦东"
  )
  const card2 = turn2.replies.find((m) => m.kind === "memory_merge")!
  const suggestionId = (card2.metadata as { suggestionId: string }).suggestionId
  await memory.resolveSuggestion(agentId, suggestionId, "merge", "住在上海浦东")
  const active = await listNotes(agentId, "active")
  assert.deepEqual(
    active.map((n) => [n.id, n.content]),
    [[old.id, "住在上海浦东"]]
  )
  assert.equal((await listNotes(agentId, "candidate")).length, 0)
  const merged = (await rows()).find((m) => m.kind === "memory_merge")!
  assert.equal((merged.metadata as { status: string }).status, "merged")
  await assert.rejects(
    memory.resolveSuggestion(agentId, suggestionId, "keep"),
    /not found/,
    "an answered suggestion cannot be answered twice"
  )

  // 4. drop: the newer note goes, the old one is untouched
  const turn3 = await run(
    scripted([
      [call("remember", { note: "住在上海浦东新区", certainty: "sure" })],
      text("好"),
    ]),
    "我住在浦东新区"
  )
  const card3 = turn3.replies.find((m) => m.kind === "memory_merge")!
  await memory.resolveSuggestion(
    agentId,
    (card3.metadata as { suggestionId: string }).suggestionId,
    "drop"
  )
  assert.deepEqual(
    (await listNotes(agentId)).map((n) => n.content),
    ["住在上海浦东"]
  )

  // 5. Different facts are saved as before, no card
  const turn4 = await run(
    scripted([
      [call("remember", { note: "养了一只猫叫团子", certainty: "sure" })],
      text("好"),
    ]),
    "我有只猫叫团子"
  )
  assert.equal(turn4.replies.filter((m) => m.kind === "memory_merge").length, 0)
  assert.equal((await listNotes(agentId, "active")).length, 2)

  // 6. A note the person writes is saved as written; a similar one only makes a card
  const mine = await memory.addNote(agentId, "养了一只猫，叫团子", "user")
  const made = await memory.suggestMerge(agentId, mine)
  assert.ok(made, "suggestion for the person's own note")
  assert.equal((await listNotes(agentId, "active")).length, 3, "note kept as written")
  assert.equal((await memory.listSuggestions(agentId)).length, 1)

  // 7. Scan finds old pairs; deleting a note closes its cards; redoing a turn drops its candidate
  await pool.query("DELETE FROM memory_suggestions")
  await memory.addNote(agentId, "养了一只猫叫团子呀", "user")
  assert.ok((await memory.scanSimilar(agentId)) >= 1)
  const [pair] = await memory.listSuggestions(agentId)
  await memory.deleteNote(agentId, pair.memory.id)
  assert.equal((await memory.listSuggestions(agentId)).length >= 0, true)
  await pool.query("DELETE FROM memory_suggestions")
  await pool.query("DELETE FROM companion_messages")
  await pool.query("DELETE FROM memories WHERE content <> '住在上海浦东'")
  await run(
    scripted([
      [call("remember", { note: "住在上海浦东区", certainty: "sure" })],
      text("好"),
    ]),
    "再说一遍我住浦东"
  )
  assert.equal((await listNotes(agentId, "candidate")).length, 1)
  const redone = await companionChat(
    { ownerId, agentId, text: "", redo: "regenerate" },
    { model: scripted([text("嗯嗯")]), price }
  )
  assert.equal(
    (await listNotes(agentId, "candidate")).length,
    0,
    "its candidate went with the old answer"
  )
  assert.equal(redone.replies.filter((m) => m.kind === "memory_merge").length, 0)
  assert.equal((await memory.listSuggestions(agentId)).length, 0)

  // ───── pictures ─────
  const images = await import("@/lib/companion/images")
  const { companionImages } = await import("@/db/schema")
  const { HttpError } = await import("@/lib/errors")
  const { artifactDir } = await import("@/lib/env")
  const png = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: "#cc4422" } })
      .png()
      .toBuffer()
  const status = async (promise: Promise<unknown>) =>
    promise.then(
      () => 0,
      (error) => (error instanceof HttpError ? error.status : -1)
    )

  // 1. Limits: empty, too big, not a picture (also SVG and a renamed text file), huge pixel count
  assert.equal(await status(images.processImage(Buffer.alloc(0))), 400)
  assert.equal(
    await status(images.processImage(Buffer.alloc(images.MAX_UPLOAD_BYTES + 1))),
    413
  )
  assert.equal(await status(images.processImage(Buffer.from("hello world"))), 415)
  assert.equal(
    await status(
      images.processImage(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>')
      )
    ),
    415
  )
  assert.equal(
    await status(
      images.processImage(
        await sharp({
          create: { width: 9000, height: 9000, channels: 3, background: "#fff" },
        })
          .png()
          .toBuffer()
      )
    ),
    415,
    "more than 40 megapixels is refused"
  )

  // 2. Big pictures are scaled to 1280, turned upright, re-encoded to JPEG without metadata
  const big = await images.processImage(await png(4000, 3000))
  assert.deepEqual([big.width, big.height], [1280, 960])
  const small = await images.processImage(await png(200, 100))
  assert.deepEqual(
    [small.width, small.height],
    [200, 100],
    "small pictures are not enlarged"
  )
  const tagged = await sharp({
    create: { width: 300, height: 200, channels: 3, background: "#224488" },
  })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "secret-gps-owner" } } })
    .toBuffer()
  const upright = await images.processImage(tagged)
  assert.deepEqual([upright.width, upright.height], [200, 300], "EXIF rotation applied")
  const outMeta = await sharp(upright.data).metadata()
  assert.equal(outMeta.format, "jpeg")
  assert.equal(outMeta.exif, undefined, "metadata stripped")
  assert.equal(upright.data.includes(Buffer.from("secret-gps-owner")), false)
  const gif = await sharp(await png(50, 50))
    .gif()
    .toBuffer()
  assert.equal((await images.processImage(gif)).width, 50, "gif accepted")

  // 3. Storage: private file, expiry, purge keeps the row
  const stored = await images.saveImage(agentId, await png(640, 480), "web")
  const file = path.resolve(artifactDir, stored.path!)
  assert.ok(file.startsWith(artifactDir + path.sep))
  assert.equal((await stat(file)).mode & 0o077, 0, "file readable by the owner only")
  assert.equal((await sharp(await readFile(file)).metadata()).format, "jpeg")
  const days = (stored.expiresAt.getTime() - stored.createdAt!.getTime()) / 86_400_000
  assert.equal(Math.round(days), images.RETENTION_DAYS)
  assert.ok(await images.getImage(agentId, stored.id))
  assert.equal(
    await images.getImage("someone-else", stored.id),
    null,
    "other agents cannot see it"
  )
  assert.ok(await images.readImage(stored))
  assert.equal(await images.purgeImages(new Date(Date.now() + 86_400_000)), 0, "not yet")
  assert.equal(
    await images.purgeImages(new Date(Date.now() + 31 * 86_400_000)),
    1,
    "after 30 days"
  )
  await assert.rejects(stat(file))
  const purged = (await images.getImage(agentId, stored.id))!
  assert.equal(purged.path, null)
  assert.equal(await images.readImage(purged), null)

  // 4. Reading the model's look at a picture
  assert.deepEqual(
    images.parseSeen('好的 {"description":"一盘红烧肉","sensitive":false}'),
    {
      description: "一盘红烧肉",
      sensitive: false,
    }
  )
  assert.equal(images.parseSeen("看不清"), null)
  assert.equal(images.parseSeen('{"description":"","sensitive":false}'), null)
  assert.equal(images.parseSeen('{"description":"x","sensitive":"no"}'), null)

  // A model that can look at pictures: `look` answers the short vision call, the script is the chat
  const usage = {
    inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  }
  const seer = (
    steps: Array<Array<Record<string, unknown>>>,
    look: string | Error,
    seen: string[] = [],
    looks: string[] = []
  ) => {
    const model = scripted(steps, seen)
    model.doGenerate = async (options) => {
      looks.push(JSON.stringify(options.prompt))
      if (look instanceof Error) throw look
      return {
        content: [{ type: "text", text: look }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }
    }
    return model
  }
  const hasPicture = (prompt: string) =>
    prompt.includes('"type":"file"') && prompt.includes("image/jpeg")
  const food = '{"description":"桌上一盘红烧肉和一碗米饭","sensitive":false}'
  const selfie = '{"description":"一个人在镜子前的自拍","sensitive":true}'
  await pool.query("DELETE FROM companion_messages")
  await pool.query("DELETE FROM memories")
  await pool.query("DELETE FROM memory_suggestions")

  // 5. She sees the picture in the turn it is sent, and only keeps the description afterwards
  const dinner = await images.saveImage(agentId, await png(800, 600))
  const seen1: string[] = []
  const looks1: string[] = []
  const first = await companionChat(
    { ownerId, agentId, text: "今天的晚饭", imageId: dinner.id },
    {
      model: seer(
        [
          [call("remember", { note: "今晚吃红烧肉", certainty: "sure" })],
          text("看着好香\n\n你自己做的吗"),
        ],
        food,
        seen1,
        looks1
      ),
      price,
    }
  )
  assert.equal((first.user.metadata as { imageId: string }).imageId, dinner.id)
  assert.equal(looks1.length, 1, "one vision call")
  assert.ok(hasPicture(looks1[0]))
  assert.ok(hasPicture(seen1[0]), "the chat call carries the picture")
  assert.ok(seen1[0].includes("对方刚发来的图片"))
  assert.ok(!seen1[0].includes("私密内容"), "ordinary picture")
  assert.deepEqual(
    first.replies.map((m) => m.content),
    ["看着好香", "你自己做的吗"]
  )
  const described = (await images.getImage(agentId, dinner.id))!
  assert.equal(described.description, "桌上一盘红烧肉和一碗米饭")
  assert.equal(described.sensitive, false)
  assert.deepEqual(
    (await listNotes(agentId, "active")).map((n) => n.content),
    ["今晚吃红烧肉"],
    "an ordinary picture does not stop her noting what you said"
  )
  const usageRows = await pool.query("SELECT count(*)::int AS n FROM companion_usage")
  assert.ok(usageRows.rows[0].n >= 2, "both calls are billed")
  const seen2: string[] = []
  await companionChat(
    { ownerId, agentId, text: "对，刚做的" },
    { model: seer([text("厉害")], food, seen2), price }
  )
  assert.ok(!hasPicture(seen2[0]), "later turns do not resend the picture")
  assert.ok(
    seen2[0].includes("发来一张图片：桌上一盘红烧肉和一碗米饭"),
    "but keep the description"
  )

  // 6. Regenerate answers the same picture again without looking twice
  const looks2: string[] = []
  const seen3: string[] = []
  // (a new turn first, so the picture is in the latest round)
  const dinner2 = await images.saveImage(agentId, await png(300, 300))
  await companionChat(
    { ownerId, agentId, text: "", imageId: dinner2.id },
    { model: seer([text("这是什么")], food, [], []), price }
  )
  await companionChat(
    { ownerId, agentId, text: "", redo: "regenerate" },
    { model: seer([text("再看一眼")], food, seen3, looks2), price }
  )
  assert.equal(looks2.length, 0, "already described")
  assert.ok(hasPicture(seen3[0]), "picture sent again to the new answer")

  // 7. A face or an ID: still answered, but nothing is kept without the person's say-so
  await pool.query("DELETE FROM memories")
  await pool.query("DELETE FROM companion_messages")
  const face = await images.saveImage(agentId, await png(400, 400))
  const seen4: string[] = []
  const faceTurn = await companionChat(
    { ownerId, agentId, text: "看我今天的样子，我叫小明", imageId: face.id },
    {
      model: seer(
        [
          [
            call("remember", { note: "叫小明", certainty: "sure" }),
            call("update_memory", { id: "none", note: "x" }),
          ],
          text("好看呀"),
        ],
        selfie,
        seen4
      ),
      price,
    }
  )
  assert.equal((await images.getImage(agentId, face.id))!.sensitive, true)
  assert.ok(seen4[0].includes("私密内容"), "she is told not to note what is in it")
  assert.equal((await listNotes(agentId, "active")).length, 0, "not saved")
  assert.equal((await listNotes(agentId, "candidate")).length, 1, "only offered")
  assert.equal(faceTurn.replies.filter((m) => m.kind === "memory_candidate").length, 1)
  assert.ok(seen4.join().includes("先不改记忆"), "update_memory is refused")

  // 8. She cannot look (model without vision, error): she says so, nothing is made up
  await pool.query("DELETE FROM memories")
  await pool.query("DELETE FROM companion_messages")
  const blind = await images.saveImage(agentId, await png(400, 400))
  const seen5: string[] = []
  const blindTurn = await companionChat(
    { ownerId, agentId, text: "你看", imageId: blind.id },
    {
      model: seer(
        [[call("remember", { note: "x", certainty: "sure" })], text("我这会儿看不到图")],
        new Error("vision not supported"),
        seen5
      ),
      price,
    }
  )
  assert.deepEqual(
    blindTurn.replies.filter((m) => m.kind === "chat").map((m) => m.content),
    ["我这会儿看不到图"]
  )
  assert.ok(!hasPicture(seen5[0]))
  assert.ok(seen5[0].includes("这次你看不到内容"))
  assert.equal(
    (await listNotes(agentId, "active")).length,
    0,
    "no notes from a picture she did not see"
  )
  assert.equal((await images.getImage(agentId, blind.id))!.sensitive, true)

  // 9. An unreadable answer from the vision call counts as sensitive but she still sees the picture
  const odd = await images.saveImage(agentId, await png(400, 400))
  const seen6: string[] = []
  await companionChat(
    { ownerId, agentId, text: "这个呢", imageId: odd.id },
    { model: seer([text("嗯")], "我不太确定", seen6), price }
  )
  assert.ok(hasPicture(seen6[0]))
  assert.ok(seen6[0].includes("私密内容"))
  const oddRow = (await images.getImage(agentId, odd.id))!
  assert.equal(oddRow.sensitive, true)
  assert.equal(oddRow.description, null)

  // 10. Bad ids and an empty message; an expired picture is not shown
  await assert.rejects(
    companionChat(
      { ownerId, agentId, text: "x", imageId: randomUUID() },
      { model: seer([text("x")], food), price }
    ),
    /找不到这张图片/
  )
  await assert.rejects(
    companionChat(
      { ownerId, agentId, text: "  " },
      { model: seer([text("x")], food), price }
    ),
    /说点什么/
  )
  const stale = await images.saveImage(
    agentId,
    await png(300, 300),
    "web",
    new Date(Date.now() - 40 * 86_400_000)
  )
  const seen7: string[] = []
  await companionChat(
    { ownerId, agentId, text: "还记得这张吗", imageId: stale.id },
    { model: seer([text("图片过期了")], food, seen7), price }
  )
  assert.ok(!hasPicture(seen7[0]), "expired picture is not sent")
  assert.ok(seen7[0].includes("这次你看不到内容"))
  // A picture with no words is a message too
  const only = await images.saveImage(agentId, await png(300, 300))
  const bare = await companionChat(
    { ownerId, agentId, text: "", imageId: only.id },
    { model: seer([text("哇")], food), price }
  )
  assert.equal(bare.user.content, "")
  assert.equal(bare.replies.length, 1)
  await db.delete(companionImages)

  await closeDurableClient()
  await pool.end()
  console.log("companion B2a integration passed")
  passed = true
} catch (error) {
  console.error(error)
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  await admin.end()
  await rm(artifacts, { recursive: true, force: true })
  process.exit(passed ? 0 : 1)
}
