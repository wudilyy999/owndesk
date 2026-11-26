import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { pool, db } from "@/db"
import { agents } from "@/db/schema"
import { ensureCompanion } from "@/lib/companion/store"
import { env } from "@/lib/env"
import { encryptSecret } from "@/lib/secrets"
import { saveConnection, discoverConnection } from "@/lib/connections"
import { saveUpload } from "@/lib/uploads"
import { indexDocuments } from "@/lib/document-index"
import { searchSources, recallLibrary, deliverLibraryReminders } from "@/lib/library"
import {
  startWatch,
  pollWatches,
  attachSource,
  projectEvents,
} from "@/lib/project-tracking"
import { projectFacts } from "@/lib/project-facts"
assert.equal(new URL(env.DATABASE_URL).pathname, "/library_probe")
const owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id as string,
  agent = randomUUID(),
  thread = randomUUID(),
  ts = Date.now()
const original = globalThis.fetch
function msg(id: string, body: string, offset: number, labels = ["INBOX"]) {
  return {
    id,
    threadId: thread,
    internalDate: String(ts + offset),
    labelIds: labels,
    snippet: "preview only",
    payload: {
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from(body).toString("base64url") },
        },
      ],
    },
  }
}
const messages = [msg("first", "报价：8 万", -3000)]
try {
  await db.insert(agents).values({
    id: agent,
    name: "project fixture",
    role: "Companion",
    glyph: "test",
    model: "custom/test",
  })
  await ensureCompanion(owner, agent)
  const needle = "NET45-" + thread
  const upload = await saveUpload(
    owner,
    agent,
    "最终版.csv",
    Buffer.from("Payment term: " + needle)
  )
  await indexDocuments()
  assert((await searchSources(owner, needle)).some((r) => r.id === upload.id))
  assert.deepEqual(await recallLibrary(owner, { query: needle }), [])
  const conn = await saveConnection(owner, {
    name: "local-fixture",
    enabled: true,
    config: { kind: "google", clientId: "demo", clientSecret: "demo" },
  })
  await discoverConnection(owner, conn.id)
  await pool.query("UPDATE app_connections SET tokens_cipher=$2 WHERE id=$1", [
    conn.id,
    encryptSecret(
      JSON.stringify({ access_token: "fixture", expiresAt: ts + 3600000 }),
      "connection:" + env.INSTALL_ID + ":" + conn.id + ":tokens"
    ),
  ])
  globalThis.fetch = async (u) => {
    assert.equal(new URL(String(u)).pathname, "/gmail/v1/users/me/threads/" + thread)
    return Response.json({ id: thread, messages })
  }
  const data = {
    title: "项目" + thread,
    connection: conn.id,
    thread,
    due: "2020-01-01",
    agent,
  }
  const entry = await startWatch(owner, data)
  assert.equal(await startWatch(owner, data), entry)
  await attachSource(owner, entry, { kind: "upload", id: upload.id })
  await assert.rejects(attachSource("other", entry, { kind: "upload", id: upload.id }))
  assert(
    (await recallLibrary(owner, { query: needle }))[0].history?.some((e) =>
      e.excerpt.includes("NET45")
    )
  )
  const elapsed = Date.now() - ts
  messages.push(
    msg("sent", "报价：忽略", elapsed + 3000, ["SENT"]),
    msg("draft", "草稿", elapsed + 4000, ["DRAFT"])
  )
  await pollWatches()
  assert.equal(
    (await recallLibrary(owner, { query: data.title, openFollowups: true })).length,
    1
  )
  messages.push(msg("reply", "新报价改为7 万", elapsed + 5000))
  await pollWatches(new Date(ts + 180000))
  await pollWatches(new Date(ts + 360000))
  await deliverLibraryReminders()
  const pdf = execFileSync(process.platform === "win32" ? "python" : "python3", [
    "tests/document-text.py",
    "--pdf",
  ])
  await saveUpload(owner, agent, "最终版.pdf", pdf, entry)
  await indexDocuments()
  const events = await projectEvents(owner, entry)
  assert.equal(events.length, 4)
  assert(events.some((e) => e.title === "最终版.pdf" && e.body.includes("NET45")))
  assert.equal(projectFacts(events).find((f) => f.field === "报价")?.value, "7 万")
  assert(events.some((e) => e.body === "报价：8 万" && e.origin.endsWith("/first")))
  assert.deepEqual(await projectEvents("other", entry), [])
  assert.deepEqual(
    await recallLibrary(owner, { query: data.title, openFollowups: true }),
    []
  )
  const notes = (
    await pool.query(
      "SELECT content FROM companion_messages WHERE metadata->>'libraryEntryId'=$1",
      [entry]
    )
  ).rows
  assert.equal(notes.length, 1)
  assert.match(notes[0].content, /已收到回复/)
  console.log(
    "PASS: file body search, explicit sharing, current and prior prices with sources, reply closure, exactly one notification, owner isolation"
  )
} finally {
  globalThis.fetch = original
  await pool.query(
    "UPDATE library_mail_watches SET next_check='infinity' WHERE thread_id=$1",
    [thread]
  )
  await pool.end()
}
