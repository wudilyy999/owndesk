import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { once } from "node:events"
import path from "node:path"
import pg from "pg"
import type { ModelMessage } from "ai"

// Controlled provider + real isolated PostgreSQL ledger. The health-only Docker
// fixture rejects every operation except /health; this is NOT a desktop test.
if (process.argv[2] === "--resume") {
  const input = JSON.parse(await readFile(process.argv[3], "utf8"))
  const { decide } = await import("@/worker/model")
  const { pool } = await import("@/db")
  try {
    const decision = await decide(input.taskId, 1, 1, input.history, 1)
    await writeFile(process.argv[3] + ".result.json", JSON.stringify(decision))
  } finally {
    await pool.end()
  }
} else {
  process.loadEnvFile(".env")
  const continuation = ["--tail", "--edges"].includes(process.argv[2])
    ? JSON.parse(await readFile(path.join(process.argv[3], "result.json"), "utf8"))
    : null
  const originalEnv = await readFile(".env")
  const main = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await main.connect()
  const mainState = async () =>
    (
      await main.query(`SELECT
    (SELECT count(*)::int FROM tasks) AS tasks,
    (SELECT count(*)::int FROM task_model_attempts) AS attempts,
    (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations`)
    ).rows[0]
  const before = await mainState()
  const database =
    continuation?.database ?? `agent_context_${randomUUID().replaceAll("-", "")}`
  assert(/^agent_context_[a-f0-9]+$/.test(database))
  const directory = path.resolve("data/experiments", database)
  await mkdir(path.join(directory, "bin"), { recursive: true })
  if (!continuation) await main.query(`CREATE DATABASE "${database}"`)
  else
    await writeFile(
      path.join(
        directory,
        `result-before-${process.argv[2].slice(2)}-${Date.now()}.json`
      ),
      JSON.stringify(continuation, null, 2),
      { flag: "wx" }
    )
  const url = new URL(process.env.DATABASE_URL!)
  url.pathname = `/${database}`
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    INSTALL_ID: randomUUID(),
    MASTER_KEY: randomBytes(32).toString("hex"),
    BETTER_AUTH_SECRET: randomUUID(),
    // The 43 task tool schemas alone take about 14k tokens
    PA_CONTEXT_WINDOW_TOKENS: "49152",
    PATH: `${directory}/bin:${process.env.PATH}`,
  })
  const checks: string[] = continuation?.checks ?? []
  const requests: { compaction: boolean; mode: string; messages: any[] }[] = []
  let mode = "success",
    passed = false
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, "/v1/chat/completions")
      let raw = ""
      request.setEncoding("utf8")
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      assert.equal(body.model, "context-fixture")
      const compaction = body.messages.some(
        (message: any) =>
          message.role === "system" &&
          message.content.includes("Summarize the supplied historical")
      )
      requests.push({ compaction, mode, messages: body.messages })
      const refuseOnce = mode === "context-limit-once" && !compaction
      if (refuseOnce) mode = "success"
      if (mode === "context-limit" || refuseOnce) {
        response.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: {
              message: "maximum context length exceeded",
              code: "context_length_exceeded",
            },
          })
        )
        return
      }
      if (mode === "failed") {
        response
          .writeHead(503, { "content-type": "application/json" })
          .end(
            JSON.stringify({ error: { message: "Controlled missing summary receipt" } })
          )
        return
      }
      if (compaction) assert.equal(body.tools?.length ?? 0, 0)
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: `context-fixture-${requests.length}`,
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: compaction ? "stop" : "tool_calls",
              message: compaction
                ? {
                    role: "assistant",
                    content:
                      mode === "blank"
                        ? ""
                        : "Goal and constraints: preserve current goal. Confirmed results: file read. Unknown effects: do not repeat writes. Files: /home/agent/report.csv. Memory changes: none. Remaining steps: observe fresh desktop.",
                  }
                : {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call-next",
                        type: "function",
                        function: { name: "screen_capture", arguments: "{}" },
                      },
                    ],
                  },
            },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 80, total_tokens: 1080 },
        })
      )
    })().catch((error) => response.destroy(error))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address !== "string")
  const endpoint = `http://127.0.0.1:${address.port}/v1`
  if (!continuation) {
    const migration = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      env: process.env,
    })
    let migrationLog = ""
    migration.stdout.on("data", (chunk) => {
      migrationLog += chunk
    })
    migration.stderr.on("data", (chunk) => {
      migrationLog += chunk
    })
    await once(migration, "exit")
    await writeFile(path.join(directory, "migrate.log"), migrationLog)
    assert.equal(migration.exitCode, 0, migrationLog)
  }
  const { pool } = await import("@/db")
  const { decide, ModelRequestError } = await import("@/worker/model")
  const { setSettings } = await import("@/lib/config")
  const { setCustomPrice } = await import("@/lib/spend")
  const tasks: string[] = []
  const makeTask = async () => {
    const taskId = randomUUID(),
      agentId = randomUUID()
    tasks.push(taskId)
    await pool.query(
      "INSERT INTO agents(id,name,role,glyph,created_at,updated_at) VALUES($1,'Context fixture','Controlled context only','fixture',now(),now())",
      [agentId]
    )
    await pool.query(
      `INSERT INTO tasks(id,owner_id,agent_id,source,request_key,request_payload,goal,status,completion_contract,config_snapshot,budget,created_at,updated_at)
      VALUES($1,'context-owner',$2,'context-fixture',$1,'{}','Pinned goal','running','{}',$3,'{"maxSteps":40}',now(),now())`,
      [
        taskId,
        agentId,
        JSON.stringify({
          model: "custom/context-fixture",
          instructions: "",
          memories: [],
          runtime: "agent",
        }),
      ]
    )
    await pool.query(
      `INSERT INTO workstation_control(agent_id,container_name,connection_secret,mode,epoch,boot_id,active_task_id,active_segment,updated_at)
      VALUES($1,$2,'unused-health-only','agent',7,'fixture-boot',$3,1,now())`,
      [agentId, `context-health-fixture-${agentId}`, taskId]
    )
    // The transport name is per-agent unique in SQL; the fake CLI validates it.
    return { taskId, agentId }
  }
  // Accept exactly the generated health container name, never arbitrary commands.
  await writeFile(
    path.join(directory, "bin/docker"),
    `#!${process.execPath}
import assert from 'node:assert/strict'; const args=process.argv.slice(2);
assert.match(args[1], /^context-health-fixture-[a-f0-9-]+$/);
assert.deepEqual([args[0],...args.slice(2)], ['exec','curl','-fsS','http://127.0.0.1:6079/health']);
process.stdout.write(JSON.stringify({ready:true,protocolVersion:6,mode:'agent',epoch:7,bootId:'fixture-boot',active:0,shellUsed:false}));
`,
    { mode: 0o700 }
  )
  const history: ModelMessage[] = [
    {
      role: "system",
      content: "Standing rules: require approval; never repeat unknown writes.",
    },
    { role: "user", content: "Pinned goal and exact completion contract" },
  ]
  for (let index = 0; index < 18; index++)
    history.push(
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "OLD REASONING ".repeat(400) },
          {
            type: "tool-call",
            toolCallId: `read-${index}`,
            toolName: "fs_read",
            input: { path: "/home/agent/report.csv" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `read-${index}`,
            toolName: "fs_read",
            output: {
              type: "json",
              value: {
                ok: true,
                path: "/home/agent/report.csv",
                content: `${index}:` + "row\n".repeat(2000),
              },
            },
          },
        ],
      }
    )
  history.push({
    role: "user",
    content: "Latest owner correction: do not send any email.",
  })
  const rawHistory = JSON.stringify(history)
  try {
    await pool.query(
      "INSERT INTO owners(user_id,created_at) VALUES('context-owner',now()) ON CONFLICT DO NOTHING"
    )
    await setSettings([
      { key: "provider.custom.apiKey", value: "controlled-local-key" },
      { key: "provider.custom.baseUrl", value: endpoint },
    ])
    await setCustomPrice("custom/context-fixture", { input: 1, output: 1 })
    if (!continuation) {
      const success = await makeTask()
      assert.deepEqual(await decide(success.taskId, 1, 1, history, 1), {
        kind: "compacted",
      })
      assert.equal(requests.length, 1)
      assert.equal(requests[0].compaction, true)
      const inputFile = path.join(directory, "resume.json")
      await writeFile(inputFile, JSON.stringify({ taskId: success.taskId, history }))
      const resumed = spawn(
        process.execPath,
        ["--import", "tsx", "tests/context-ledger.ts", "--resume", inputFile],
        { env: process.env }
      )
      let resumeLog = ""
      resumed.stdout.on("data", (chunk) => {
        resumeLog += chunk
      })
      resumed.stderr.on("data", (chunk) => {
        resumeLog += chunk
      })
      await once(resumed, "exit")
      await writeFile(path.join(directory, "resume.log"), resumeLog)
      assert.equal(resumed.exitCode, 0, resumeLog)
      const next = JSON.parse(await readFile(inputFile + ".result.json", "utf8"))
      assert.equal(next.kind, "decision")
      assert.equal(requests.length, 2)
      assert.equal(requests[1].compaction, false)
      assert(JSON.stringify(requests[1].messages).includes("Latest owner correction"))
      assert(
        JSON.stringify(requests[1].messages).includes("Historical continuation summary")
      )
      assert.deepEqual(await decide(success.taskId, 1, 1, history, 1), next)
      assert.equal(requests.length, 2, "saved decision replay has no API effect")
      const attempts = (
        await pool.query(
          "SELECT decision_no,status,cost_micros,usage FROM task_model_attempts WHERE task_id=$1 ORDER BY decision_no",
          [success.taskId]
        )
      ).rows
      assert.deepEqual(
        attempts.map((row) => [row.decision_no, row.status]),
        [
          [-1, "succeeded"],
          [1, "succeeded"],
        ]
      )
      assert(
        attempts.every((row) => Number(row.cost_micros) > 0 && row.usage.input === 1000)
      )
      checks.push(
        "Real SDK compaction, durable checkpoint, fresh-process continuation, pinned owner input, original attempt pricing and zero-request replay"
      )

      const backlog = await makeTask()
      const backlogHistory: ModelMessage[] = [
        { role: "system", content: "History fixture" },
      ]
      for (let i = 0; i < 110; i++)
        backlogHistory.push(
          { role: "user", content: `[question-${i}] ${"旧记录".repeat(450)}` },
          { role: "assistant", content: `[reply-${i}]` }
        )
      backlogHistory.push({
        role: "user",
        content: "Current owner correction must stay verbatim.",
      })
      const threadId = randomUUID()
      await pool.query(
        "INSERT INTO threads(id,agent_id,created_at,active_at) VALUES($1,$2,now(),now())",
        [threadId, backlog.agentId]
      )
      const admissionClient = await pool.connect()
      const { continuationAtAdmission } = await import("@/lib/continuation")
      const priorTurns = backlogHistory.slice(1, -1) as {
        role: "user" | "assistant"
        content: string
      }[]
      const admission = async (turns = priorTurns, agent = backlog.agentId) =>
        continuationAtAdmission(
          admissionClient,
          "context-owner",
          agent,
          "thread",
          threadId,
          turns
        )
      try {
        await pool.query(
          "UPDATE tasks SET thread_id=$2,config_snapshot=config_snapshot || $3::jsonb WHERE id=$1",
          [backlog.taskId, threadId, JSON.stringify(await admission())]
        )
        const beforeBacklog = requests.length
        let no = 1
        for (let n = 0; n < 20; n++) {
          const outcome = await decide(
            backlog.taskId,
            1,
            no,
            backlogHistory,
            backlogHistory.length - 1
          )
          if (outcome.kind === "decision") break
          assert.equal(outcome.kind, "compacted")
          if (outcome.more) no++
        }
        const batches = requests.slice(beforeBacklog)
        assert(batches.filter((r) => r.compaction).length >= 2)
        assert.equal(batches.at(-1)?.compaction, false)
        const sent = batches
          .filter((r) => r.compaction)
          .flatMap((r) =>
            JSON.parse(
              r.messages.find((m: any) => m.role === "user").content
            ).transcript.map((m: any) => m.content)
          )
        assert.deepEqual(
          sent,
          backlogHistory.slice(1, sent.length + 1).map((m) => m.content)
        )
        assert(JSON.stringify(batches.at(-1)?.messages).includes("[reply-109]"))
        assert(
          JSON.stringify(batches.at(-1)?.messages).includes(
            "Current owner correction must stay verbatim."
          )
        )
        checks.push(
          "Oversized thread: consecutive independently billed compactions cover full original pairs once; final request keeps recent replies and owner correction verbatim"
        )

        const nextTask = await admission()
        assert.equal(nextTask.continuation.after, sent.length)
        assert.equal(nextTask.conversation[0].role, "assistant")
        assert.deepEqual(nextTask.conversation.slice(1), priorTurns.slice(sent.length))
        assert(
          (await admission([{ role: "user", content: "edited" }, ...priorTurns.slice(1)]))
            .continuation.after === 0
        )
        assert((await admission(priorTurns, randomUUID())).continuation.after === 0)
        assert(
          !JSON.stringify(batches.filter((r) => r.compaction)).includes(
            "Current owner correction must stay verbatim."
          )
        )
      } finally {
        admissionClient.release()
      }
      const forgottenTask = await makeTask()
      const { executeMemoryTool } = await import("@/worker/memory")
      const secretNote = "Retired code: CLOCK-MOSS-092"
      const recorded = await executeMemoryTool(
        forgottenTask.taskId,
        1,
        1,
        "memory_write",
        { note: secretNote },
        7
      )
      const noteId = (recorded.output as { id: string }).id
      await executeMemoryTool(
        forgottenTask.taskId,
        1,
        2,
        "memory_forget",
        { id: noteId },
        7
      )
      await executeMemoryTool(
        forgottenTask.taskId,
        1,
        2,
        "memory_forget",
        { id: noteId },
        7
      )
      assert.deepEqual(
        (
          await pool.query(
            "SELECT op FROM memory_changes WHERE memory_id=$1 ORDER BY created_at,id",
            [noteId]
          )
        ).rows.map((r) => r.op),
        ["add", "delete"]
      )
      const frozen: ModelMessage[] = [
        { role: "system", content: `old frozen life note: ${secretNote}` },
        { role: "assistant", content: "Earlier errand used CLOCK-MOSS-092" },
        { role: "user", content: "Use the current file naming convention" },
      ]
      const pendingWire = requests.length
      assert.equal((await decide(forgottenTask.taskId, 1, 1, frozen, 2)).kind, "decision")
      assert.equal(requests.length, pendingWire + 1)
      assert(!JSON.stringify(requests.at(-1)?.messages).includes("CLOCK-MOSS-092"))
      assert(JSON.stringify(requests.at(-1)?.messages).includes("current file naming"))
      checks.push(
        "Task memory removal commits one shared change record despite replay; released fact is absent from the next provider request including frozen context"
      )
      mode = "failed"
      const failed = await makeTask()
      await assert.rejects(
        () => decide(failed.taskId, 1, 1, history, 1),
        (error: unknown) => error instanceof ModelRequestError && error.decisionNo === -1
      )
      const afterFailure = requests.length
      await assert.rejects(
        () => decide(failed.taskId, 1, 1, history, 1),
        /previous model request failed/
      )
      assert.equal(requests.length, afterFailure)
      const unknown = (
        await pool.query(
          "SELECT status,cost_micros FROM task_model_attempts WHERE task_id=$1",
          [failed.taskId]
        )
      ).rows
      assert.deepEqual(unknown, [{ status: "unknown", cost_micros: null }])
      checks.push(
        "Missing compaction receipt remains unknown/unpriced; normal request and automatic retry are blocked"
      )

      mode = "blank"
      const invalid = await makeTask()
      await assert.rejects(
        () => decide(invalid.taskId, 1, 1, history, 1),
        /compaction returned/
      )
      const afterBlank = requests.length
      await assert.rejects(
        () => decide(invalid.taskId, 1, 1, history, 1),
        /compaction returned/
      )
      assert.equal(requests.length, afterBlank)
      assert.equal(
        (
          await pool.query("SELECT status FROM task_model_attempts WHERE task_id=$1", [
            invalid.taskId,
          ])
        ).rows[0].status,
        "succeeded"
      )
      checks.push(
        "Invalid returned summary is a saved billed response, rejected without repeat requests or invented fallback"
      )

      const interrupted = await makeTask()
      await pool.query(
        "INSERT INTO task_model_decisions(task_id,segment_no,decision_no,epoch,status,created_at) VALUES($1,1,-1,7,'pending',now())",
        [interrupted.taskId]
      )
      await pool.query(
        "INSERT INTO task_model_attempts(task_id,segment_no,decision_no,attempt_no,model,status,started_at) VALUES($1,1,-1,1,'custom/context-fixture','pending',now())",
        [interrupted.taskId]
      )
      const request = await decide(interrupted.taskId, 1, 1, [], 1)
      assert.equal(request.kind, "request")
      assert.equal(requests.length, afterBlank)
      const pending = (
        await pool.query("SELECT payload FROM task_requests WHERE task_id=$1", [
          interrupted.taskId,
        ])
      ).rows[0].payload
      assert.equal(pending.purpose, "model_retry")
      assert.equal(pending.decisionNo, -1)
      checks.push(
        "Interrupted compaction requires the original retry-consent request, even when current history is empty"
      )
    }

    mode = "success"
    const beforeGates = requests.length
    if (process.argv[2] !== "--edges") {
      const blocked = await makeTask()
      await setSettings([{ key: "usage.monthlyBudget", value: "0" }])
      assert.equal((await decide(blocked.taskId, 1, 1, history, 1)).kind, "request")
      assert.equal(requests.length, beforeGates)
      assert.equal(
        (
          await pool.query(
            "SELECT payload->>'purpose' AS purpose FROM task_requests WHERE task_id=$1",
            [blocked.taskId]
          )
        ).rows[0].purpose,
        "monthly"
      )
      await setSettings([{ key: "usage.monthlyBudget", value: null }])
      checks.push(
        "Original monthly budget gate blocks a summary before any model intent/request"
      )

      const oversized = await makeTask()
      await assert.rejects(
        () =>
          decide(
            oversized.taskId,
            1,
            1,
            [
              { role: "system", content: "规".repeat(18000) },
              { role: "user", content: "要".repeat(16000) },
            ],
            1
          ),
        /Pinned/
      )
      assert.equal(requests.length, beforeGates)
      checks.push(
        "Pinned input with no removable history fails before spending; no compaction thrashing"
      )
    }
    if (!continuation || process.argv[2] === "--edges") {
      const soft = await makeTask()
      await pool.query(
        "UPDATE tasks SET config_snapshot=jsonb_set(config_snapshot,'{contextWindowTokens}','65536') WHERE id=$1",
        [soft.taskId]
      )
      const count = requests.length
      assert.equal(
        (
          await decide(
            soft.taskId,
            1,
            1,
            [
              { role: "system", content: "规".repeat(40000) },
              { role: "user", content: "要".repeat(1000) },
            ],
            1
          )
        ).kind,
        "decision"
      )
      assert.equal(requests.length, count + 1)
      assert(!requests.at(-1)!.compaction)
      checks.push(
        "Frozen per-Task window overrides the worker default; pinned-only input above the soft trigger remains usable within the hard reserve"
      )

      const duplicateTask = await makeTask()
      const repeated = history.map((m): ModelMessage => {
        if (m.role === "assistant" && Array.isArray(m.content))
          return { ...m, content: m.content.filter((p) => p.type !== "reasoning") }
        if (m.role === "tool")
          return {
            ...m,
            content: m.content.map((p) =>
              p.type !== "tool-result"
                ? p
                : {
                    ...p,
                    output: {
                      type: "json" as const,
                      value: { ok: true, content: "row\n".repeat(2500) },
                    },
                  }
            ),
          }
        return m
      })
      const beforeReads = requests.length
      assert.equal(
        (await decide(duplicateTask.taskId, 1, 1, repeated, 1)).kind,
        "decision"
      )
      assert.deepEqual(
        requests.slice(beforeReads).map((r) => r.compaction),
        [false]
      )
      assert.match(JSON.stringify(requests.at(-1)!.messages), /Identical read/)
      checks.push(
        "Repeated read receipts alone would overflow; folding fits and sends zero summary requests"
      )

      const rejected = await makeTask()
      const rejectedHistory: ModelMessage[] = history.slice(0, 2)
      for (let index = 0; index < 8; index++)
        rejectedHistory.push(
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "r".repeat(2800) },
              {
                type: "tool-call",
                toolName: "fs_read",
                toolCallId: `small-${index}`,
                input: { path: "/home/agent/report.csv" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "fs_read",
                toolCallId: `small-${index}`,
                output: { type: "json", value: { ok: true } },
              },
            ],
          }
        )
      // One refusal below the local trigger: compact once and rebuild the same step
      mode = "context-limit-once"
      const beforeReject = requests.length
      assert.equal(
        (await decide(rejected.taskId, 1, 1, rejectedHistory, 1)).kind,
        "compacted"
      )
      assert.deepEqual(
        requests.slice(beforeReject).map((request) => request.compaction),
        [false, true],
        "The controlled real API rejection happened below the local trigger, then one compaction"
      )
      assert.equal(
        (await decide(rejected.taskId, 1, 1, rejectedHistory, 1)).kind,
        "decision"
      )
      assert(!requests.at(-1)!.compaction)
      const receipts = (
        await pool.query(
          "SELECT decision_no,status,cost_micros FROM task_model_attempts WHERE task_id=$1 ORDER BY id",
          [rejected.taskId]
        )
      ).rows
      assert.deepEqual(
        receipts.map((row) => [row.decision_no, row.status]),
        [
          [1, "unknown"],
          [-1, "succeeded"],
          [1, "succeeded"],
        ]
      )
      assert.equal(receipts[0].cost_micros, null)
      // A refusal that compaction cannot fix stops for the owner instead of looping
      const stubborn = await makeTask()
      mode = "context-limit"
      const beforeStubborn = requests.length
      await assert.rejects(
        () => decide(stubborn.taskId, 1, 1, rejectedHistory, 1),
        /ContextWindowExceeded/
      )
      await assert.rejects(
        () => decide(stubborn.taskId, 1, 1, rejectedHistory, 1),
        /previous model request failed/
      )
      assert.deepEqual(
        requests.slice(beforeStubborn).map((request) => request.compaction),
        [false, true]
      )
      mode = "success"
      checks.push(
        "Upstream context rejection keeps unknown billing, compacts once automatically and rebuilds the same step; a repeated rejection stops without more requests"
      )

      const cancelled = await makeTask()
      const beforeCancel = requests.length
      await pool.query("UPDATE tasks SET cancel_requested_at=now() WHERE id=$1", [
        cancelled.taskId,
      ])
      await assert.rejects(() => decide(cancelled.taskId, 1, 1, history, 1), /cancel/i)
      assert.equal(requests.length, beforeCancel)
      checks.push(
        "Cancellation blocks both summary and ordinary model requests before dispatch"
      )
    }
    assert.equal(JSON.stringify(history), rawHistory)
    assert.deepEqual(await mainState(), before)
    assert((await readFile(".env")).equals(originalEnv))
    checks.push(
      "Raw history, main Task/attempt/migration counts and .env remain unchanged"
    )
    passed = true
  } finally {
    await pool.query(
      "UPDATE tasks SET status='cancelled',cancel_requested_at=now() WHERE source='context-fixture'"
    )
    const report = {
      recordedAt: new Date().toISOString(),
      passed,
      database,
      checks: [...new Set(checks)],
      localFixtureRequests: (continuation?.localFixtureRequests ?? 0) + requests.length,
      cloudModelRequests: 0,
      realDesktopActions: 0,
      tasks: (
        await pool.query(
          "SELECT count(*)::int AS count FROM tasks WHERE source='context-fixture'"
        )
      ).rows[0].count,
      mainUnchanged: JSON.stringify(await mainState()) === JSON.stringify(before),
      envUnchanged: (await readFile(".env")).equals(originalEnv),
      scope:
        "Production decide/generateText and PostgreSQL ledger with local fixed responses and health-only CLI fixture. Fresh child process resumed the saved summary. No DBOS workflow/desktop/cloud-model quality acceptance or deployment claim.",
    }
    await writeFile(path.join(directory, "result.json"), JSON.stringify(report, null, 2))
    if (passed)
      await writeFile(
        "docs/evidence/context-compaction-ledger.json",
        JSON.stringify(report, null, 2)
      )
    await pool.end()
    await main.end()
    server.close()
    server.closeAllConnections()
    console.log(
      JSON.stringify({
        passed,
        directory,
        checks: checks.length,
        localFixtureRequests: requests.length,
      })
    )
  }
}
