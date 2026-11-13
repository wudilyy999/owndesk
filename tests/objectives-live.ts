// Long-running objective with the REAL model service (needs the network and a workstation image).
// Runs in a throwaway database with its own worker; not part of `npm test`:
// `npm run test:objectives:live`. It prints each round.
//   scenarios: a CSV objective is worked on over at least two rounds and accepted by its file
//   check · in chat she turns a clearly long-running request into an objective card.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import { workstationImage } from "./workstation-image"

process.loadEnvFile(".env")
const spec = process.env.OBJECTIVES_LIVE_MODEL ?? process.env.OWNDESK_DEFAULT_MODEL
assert.ok(spec, "no model configured (OWNDESK_DEFAULT_MODEL or OBJECTIVES_LIVE_MODEL)")
const database = `agent_objlive_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  APP_URL: "http://127.0.0.1:17197",
  WORKER_PORT: "17198",
  WORKSTATION_IMAGE: workstationImage,
  ARTIFACT_DIR: path.join(directory, "artifacts"),
  OWNER_EMAIL: "objectives-live@fixture.test",
  OWNER_PASSWORD: randomUUID(),
})

async function command(file: string) {
  const child = spawn(process.execPath, ["--import", "tsx", file], { env: process.env })
  let output = ""
  child.stdout!.on("data", (data) => (output += data))
  child.stderr!.on("data", (data) => (output += data))
  const [code] = await once(child, "exit")
  assert.equal(code, 0, output)
}
let worker: ChildProcess | undefined
let workerLog = ""
let passed = false
const agentIds: string[] = []
try {
  await command("scripts/migrate.ts")
  await command("scripts/owner.ts")
  const { db, pool } = await import("@/db")
  const { closeDurableClient } = await import("@/lib/durable")
  const { createObjective, advanceObjectives } = await import("@/lib/objectives")
  const { companionChat } = await import("@/lib/companion/chat")
  const { ensureCompanion, updateCompanion } = await import("@/lib/companion/store")
  const { dockerRaw } = await import("@/lib/docker")
  const { workstationName, viewerName, workstationVolume, displayVolume } =
    await import("@/lib/workstation")
  const { companionMessages, objectives } = await import("@/db/schema")
  const { eq } = await import("drizzle-orm")
  try {
    const ownerId = (await pool.query("SELECT user_id FROM owners")).rows[0]
      .user_id as string
    worker = spawn(process.execPath, ["--import", "tsx", "worker/main.ts"], {
      env: process.env,
      detached: true,
    })
    worker.stdout!.on("data", (data) => (workerLog += data))
    worker.stderr!.on("data", (data) => (workerLog += data))
    const until = async <T>(
      fn: () => Promise<T | false | undefined>,
      name: string,
      ms: number
    ) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (worker!.exitCode !== null) throw new Error(`worker exited\n${workerLog}`)
        const result = await fn()
        if (result) return result
        await delay(1000)
      }
      throw new Error(`Timed out: ${name}`)
    }
    await until(async () => workerLog.includes("Worker ready"), "worker ready", 120_000)

    // 1. A CSV objective worked on round after round with the real model
    const agentId = randomUUID()
    agentIds.push(agentId)
    await pool.query(
      "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'目标助手','Long-running objective live test',$2,$3,now(),now())",
      [agentId, randomUUID(), spec]
    )
    const objective = await createObjective(ownerId, {
      agentId,
      title: "三个月的记账表",
      objective: [
        "Build /home/agent/ledger.csv with the columns month,amount for 2026-01, 2026-02 and 2026-03, where the amount of a month is its month number times 100 (100, 200, 300).",
        "Work strictly one month per round: in each round read ledger.csv if it exists (create it with the header in the first round), append exactly ONE missing month in order, then end the round.",
        "End a round with objective.status=progress while any month is missing. Only in the round where you have verified that all three months are present, end with objective.status=achieved and deliver /home/agent/ledger.csv.",
      ].join("\n"),
      doneCriteria:
        "ledger.csv has exactly the three months 2026-01..2026-03 with amounts 100, 200, 300",
      completionContract: {
        artifact: {
          path: "/home/agent/ledger.csv",
          requiredColumns: ["month", "amount"],
          minRows: 3,
        },
      },
      budget: { roundMaxSteps: 12, maxRounds: 8 },
    })
    const rounds = async () =>
      (
        await pool.query(
          `SELECT r.round_no,r.verdict,r.steps,r.summary,t.status FROM objective_rounds r
           LEFT JOIN tasks t ON t.id=r.task_id WHERE r.objective_id=$1 ORDER BY r.round_no`,
          [objective.id]
        )
      ).rows
    const printed = new Set<number>()
    const final = await until(
      async () => {
        await advanceObjectives()
        for (const round of await rounds())
          if (round.verdict && !printed.has(round.round_no)) {
            printed.add(round.round_no)
            console.log(
              `round ${round.round_no}: ${round.verdict} (${round.steps} steps) ${String(round.summary).slice(0, 200)}`
            )
          }
        const [row] = await db
          .select()
          .from(objectives)
          .where(eq(objectives.id, objective.id))
        return row.status === "active" ? undefined : row
      },
      "objective settles",
      20 * 60_000
    )
    assert.equal(final.status, "achieved", `ended ${final.status}: ${final.statusReason}`)
    const done = await rounds()
    assert.ok(
      done.length >= 2,
      `achieved in ${done.length} round(s); the test needs at least two`
    )
    assert.equal(done.at(-1)!.verdict, "achieved")
    const { rows: delivered } = await pool.query(
      `SELECT a.storage_path FROM objective_rounds r JOIN artifacts a ON a.task_id=r.task_id
       WHERE r.objective_id=$1 AND r.verdict='achieved'`,
      [objective.id]
    )
    assert.equal(delivered.length, 1, "the achieved round delivered the CSV")
    const { readFile } = await import("node:fs/promises")
    const stored = delivered[0].storage_path as string
    const csv = await readFile(
      path.isAbsolute(stored) ? stored : path.resolve(process.env.ARTIFACT_DIR!, stored),
      "utf8"
    )
    console.log(`ledger.csv:\n${csv.trim()}`)
    for (const [month, amount] of [
      ["2026-01", 100],
      ["2026-02", 200],
      ["2026-03", 300],
    ])
      assert.match(csv, new RegExp(`${month}\\s*,\\s*"?${amount}(\\.0+)?"?\\s*$`, "m"))
    console.log(`objective achieved in ${done.length} rounds`)

    // 2. In chat, a clearly long-running request becomes an objective card
    const companionId = randomUUID()
    await pool.query(
      "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'小满','Companion',$2,$3,now(),now())",
      [companionId, randomUUID(), spec]
    )
    await ensureCompanion(ownerId, companionId, "Asia/Taipei")
    await updateCompanion(ownerId, companionId, { typingPace: "off" })
    {
      await companionChat(
        {
          ownerId,
          agentId: companionId,
          text: "这是个长期目标，要分很多轮慢慢做：帮我把电脑里 2026 年的所有发票整理成一张汇总表，每张发票一行，全部整理完才算完成。你先发个长期目标给我确认。",
        },
        {}
      )
    }
    const [card] = await db
      .select()
      .from(companionMessages)
      .where(eq(companionMessages.kind, "objective_proposal"))
    assert.ok(card, "she proposed a long-running objective card")
    const proposal = (card.metadata as { proposal: { title: string; objective: string } })
      .proposal
    console.log(`card: ${proposal.title} — ${proposal.objective.slice(0, 120)}`)
    assert.match(proposal.objective + proposal.title, /发票/)
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS n FROM objectives WHERE agent_id=$1", [
          companionId,
        ])
      ).rows[0].n,
      0,
      "nothing starts before the card is confirmed"
    )
    console.log("objectives live passed")
    passed = true
  } finally {
    if (worker?.pid && worker.exitCode === null) {
      const exited = once(worker, "exit")
      process.kill(-worker.pid, "SIGTERM")
      await exited
    }
    await writeFile(path.join(directory, "worker.log"), workerLog)
    for (const id of agentIds) {
      for (const name of [viewerName(id), workstationName(id)])
        await dockerRaw(["rm", "--force", name])
      for (const volume of [workstationVolume(id), displayVolume(id)])
        await dockerRaw(["volume", "rm", volume])
    }
    await closeDurableClient()
    await pool.end()
  }
} catch (error) {
  console.error(error)
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  await admin.end()
  process.exit(passed ? 0 : 1)
}
