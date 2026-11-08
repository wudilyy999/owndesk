import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"

process.loadEnvFile(".env")
const database = `agent_memory_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
process.env.DATABASE_URL = url.toString()
const checks: string[] = []
let passed = false
try {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  })
  await once(child, "exit")
  assert.equal(child.exitCode, 0)
  const { pool } = await import("@/db")
  try {
    const { taskMemoryContext } = await import("@/lib/task-memory")
    const { recallNotes } = await import("@/lib/companion/memory")
    const { toolsForTask } = await import("@/lib/agent/tools")
    const { buildInstructions } = await import("@/lib/agent/instructions")
    const { compactContext } = await import("@/lib/agent/context")
    const agent = randomUUID(),
      other = randomUUID(),
      summary = randomUUID(),
      oldest = randomUUID()
    for (const id of [agent, other])
      await pool.query(
        "INSERT INTO agents(id,name,role,glyph,created_at,updated_at) VALUES($1,'Memory','Assistant','fixture',now(),now())",
        [id]
      )
    await pool.query(
      "INSERT INTO memories(id,agent_id,kind,topic,content,created_at) VALUES($1,$2,'summary','Reports','Report preferences',now())",
      [summary, agent]
    )
    await pool.query(
      "INSERT INTO memories(id,agent_id,summary_id,content,created_at) VALUES($1,$2,$3,'Old preference: use blue totals',now()-interval '1 year')",
      [oldest, agent, summary]
    )
    await pool.query(
      "INSERT INTO memories(id,agent_id,summary_id,content,created_at) SELECT gen_random_uuid()::text,$1,$2,'Recent note ' || n,now()+n*interval '1 second' FROM generate_series(1,70) n",
      [agent, summary]
    )
    await pool.query(
      "INSERT INTO memories(id,agent_id,content,created_at,status) VALUES($1,$2,'Candidate secret',now(),'candidate'),($3,$4,'Foreign secret',now(),'active')",
      [randomUUID(), agent, randomUUID(), other]
    )
    const context = await taskMemoryContext(agent)
    assert.equal(context.memories.length, 30)
    assert(!context.memories.join().includes("Old preference"))
    const prompt = buildInstructions(
      { instructions: "", ...context },
      new Date().toISOString()
    )
    assert.match(prompt, /Report preferences/)
    assert.match(prompt, /recall_memory/)
    assert.doesNotMatch(prompt, /Candidate secret|Foreign secret/)
    assert(Object.hasOwn(toolsForTask({}), "recall_memory"))
    assert(
      Object.hasOwn(toolsForTask({ workstationChannel: "desktop" }), "recall_memory")
    )
    for (const config of [
      { lifeSession: {} },
      { manualCompilation: {} },
      { workflowCompilation: {} },
    ])
      assert(!Object.hasOwn(toolsForTask(config), "recall_memory"))
    checks.push(
      "Bounded initial memory carries topic summaries; recall available in ordinary/desktop tasks with correct mode scope"
    )
    for (const topic of [undefined, "Reports"]) {
      const first = await recallNotes(agent, { topic, page: 1 })
      assert("pages" in first && first.pages === 5)
      const ids = new Set<string>()
      for (let page = 1; page <= first.pages!; page++) {
        const result = await recallNotes(agent, { topic, page })
        assert("notes" in result)
        assert(result.notes!.length <= 16)
        const projected = compactContext([
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "recall_memory",
                toolCallId: "recall",
                output: { type: "json", value: result },
              },
            ],
          },
        ])
        for (const note of result.notes!) {
          assert(!ids.has(note.id))
          ids.add(note.id)
          assert(
            JSON.stringify(projected).includes(note.content),
            "Every note remains readable through model projection"
          )
        }
      }
      assert.equal(ids.size, 71)
      assert(ids.has(oldest))
    }
    checks.push(
      "All 71 active notes recalled exactly once via global and topic pagination; old note survives model context projection"
    )
    await pool.query(
      "UPDATE memories SET content='Changed preference: green totals',updated_at=now() WHERE id=$1",
      [oldest]
    )
    assert(
      JSON.stringify(await recallNotes(agent, { topic: "Reports" })).includes(
        "green totals"
      )
    )
    await pool.query("DELETE FROM memories WHERE id=$1", [oldest])
    assert(
      !JSON.stringify(await recallNotes(agent, { page: 1 })).includes("green totals")
    )
    const latest = context.memories.at(-1)!.match(/\[([^\]]+)\]/)![1]
    await pool.query("DELETE FROM memories WHERE id=$1", [latest])
    assert(!(await taskMemoryContext(agent)).memories.join().includes(latest))
    await pool.query("UPDATE memories SET content='Current report summary' WHERE id=$1", [
      summary,
    ])
    assert(
      (await taskMemoryContext(agent)).memorySummary.includes("Current report summary")
    )
    assert("error" in (await recallNotes(other, { topic: "Reports" })))
    checks.push(
      "Fresh reads and decision context honor edits/deletions; other agent and candidate notes stay excluded"
    )
    await pool.query(
      "INSERT INTO memories(id,agent_id,kind,topic,content,created_at) SELECT gen_random_uuid()::text,$1,'summary','Topic '||n,'Topic detail '||n,now() FROM generate_series(1,35) n",
      [agent]
    )
    const overview = await recallNotes(agent, { summaries: true })
    assert("pages" in overview)
    assert.equal(overview.pages, 3)
    const topics = new Set<string>()
    for (let page = 1; page <= overview.pages!; page++) {
      const result = await recallNotes(agent, { summaries: true, page })
      assert("summaries" in result)
      for (const item of result.summaries!) topics.add(item.id)
    }
    assert.equal(topics.size, 36)
    checks.push(
      "Summary catalog also paginates; every topic remains discoverable beyond first page"
    )
    passed = true
  } finally {
    await pool.end()
  }
} finally {
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      { passed, checks, database, recordedAt: new Date().toISOString() },
      null,
      2
    )
  )
  if (passed) await admin.query(`DROP DATABASE "${database}"`)
  await admin.end()
}
console.log(JSON.stringify({ passed, checks, directory }, null, 2))
