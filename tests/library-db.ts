import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { pool, db } from "@/db"
import { agents, companionMessages } from "@/db/schema"
import { ensureCompanion } from "@/lib/companion/store"
import {
  searchSources,
  readSource,
  saveEntry,
  changeEntry,
  recallLibrary,
  deliverLibraryReminders,
} from "@/lib/library"
assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/library_probe")
const salt = randomUUID().slice(0, 8),
  agent = randomUUID(),
  key = `报价${salt}`,
  other = "foreign-" + salt
try {
  const owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id as string
  await db.insert(agents).values({
    id: agent,
    name: "资料助手" + salt,
    role: "Companion",
    glyph: "test",
    model: "custom/test",
  })
  await ensureCompanion(owner, agent)
  const [message] = await db
    .insert(companionMessages)
    .values({ agentId: agent, role: "user", kind: "chat", content: key + "原始约定" })
    .returning()
  await db.insert(companionMessages).values([
    { agentId: agent, role: "user", content: key + "撤回", supersededAt: new Date() },
    {
      agentId: agent,
      role: "assistant",
      content: key + "未显示",
      revealAt: new Date(Date.now() + 3600000),
    },
  ])
  const task = randomUUID()
  await pool.query(
    "INSERT INTO tasks(id,owner_id,agent_id,source,request_key,request_payload,goal,status,completion_contract,config_snapshot,budget,created_at,updated_at) VALUES($1,$2,$3,'web',$1,'{}',$4,'completed','{}','{}','{}',now(),now())",
    [task, owner, agent, key]
  )
  await pool.query(
    "INSERT INTO artifacts(id,task_id,name,storage_path,media_type,size,verification,created_at) VALUES($1,$2,$3,'fixture','text/plain',10,'{}',now())",
    [randomUUID(), task, key + ".txt"]
  )
  await pool.query(
    "INSERT INTO task_uploads(id,owner_id,agent_id,name,storage_path,media_type,size,created_at) VALUES($1,$2,$3,$4,'fixture','text/plain',10,now())",
    [randomUUID(), owner, agent, key + ".md"]
  )
  const hits = await searchSources(owner, key)
  assert.deepEqual(hits.map((r) => r.kind).sort(), ["artifact", "chat", "task", "upload"])
  assert.equal((await searchSources(other, key)).length, 0)
  assert.equal(await readSource(other, { kind: "chat", id: message.id }), null)
  assert.deepEqual(await recallLibrary(owner, { query: key }), [])
  const data = {
    kind: "followup",
    title: key,
    body: "待对方答复",
    source: { kind: "chat", id: message.id },
    dueDate: "2020-10-20",
    reminderAgent: agent,
  }
  await assert.rejects(saveEntry(other, data), { status: 404 })
  const entry = await saveEntry(owner, data)
  assert.equal(
    (await recallLibrary(owner, { query: key, openFollowups: true }))[0].title,
    key
  )
  assert.deepEqual(await recallLibrary(other, { query: key }), [])
  await Promise.all([deliverLibraryReminders(), deliverLibraryReminders()])
  await deliverLibraryReminders()
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM companion_messages WHERE metadata->>'libraryEntryId'=$1",
        [entry.id]
      )
    ).rows[0].n,
    1
  )
  await assert.rejects(changeEntry(other, entry.id, "complete"), { status: 404 })
  await changeEntry(owner, entry.id, "complete")
  assert.deepEqual(await recallLibrary(owner, { query: key, openFollowups: true }), [])
  await changeEntry(owner, entry.id, "reopen")
  await changeEntry(owner, entry.id, "delete")
  assert.deepEqual(await recallLibrary(owner, { query: key }), [])
  const { saveConnection, discoverConnection } = await import("@/lib/connections")
  const { googleDrafts } = await import("@/lib/library-google")
  const { encryptSecret } = await import("@/lib/secrets")
  const { env } = await import("@/lib/env")
  const conn = await saveConnection(owner, {
    name: "Fixture " + salt,
    enabled: true,
    config: { kind: "google", clientId: "probe", clientSecret: "probe" },
  })
  await discoverConnection(owner, conn.id)
  await pool.query("UPDATE app_connections SET tokens_cipher=$2 WHERE id=$1", [
    conn.id,
    encryptSecret(
      JSON.stringify({ access_token: "fixture", expiresAt: Date.now() + 3600000 }),
      `connection:${env.INSTALL_ID}:${conn.id}:tokens`
    ),
  ])
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(init?.method, "GET")
      const u = new URL(String(url))
      if (u.hostname === "gmail.googleapis.com") {
        return Response.json(
          u.pathname.endsWith("/messages")
            ? { messages: [{ id: "m1" }] }
            : {
                id: "m1",
                threadId: "t1",
                snippet: key,
                payload: { headers: [{ name: "Subject", value: "报价邮件" }] },
              }
        )
      }
      assert.equal(u.hostname, "www.googleapis.com")
      return Response.json({
        items: [
          {
            summary: "报价会议",
            start: { date: "2026-11-26" },
            htmlLink: "https://calendar.google.com/calendar/event?eid=probe",
          },
        ],
      })
    }
    assert.equal((await googleDrafts(owner, conn.id, "mail", key))[0].body, key)
    assert.equal(
      (await googleDrafts(owner, conn.id, "calendar", ""))[0].title,
      "报价会议"
    )
    await assert.rejects(googleDrafts(other, conn.id, "mail", ""), { status: 404 })
    assert.equal((await recallLibrary(owner, { query: key })).length, 0)
  } finally {
    globalThis.fetch = original
  }
  console.log(
    "PASS: Google mail/calendar preview via controlled provider; no implicit saving"
  )
  console.log(
    "PASS: 4 searchable source types, hidden message exclusion, owner isolation, explicit sharing, reminder deduplication, completion and deletion"
  )
} finally {
  await pool.end()
}
