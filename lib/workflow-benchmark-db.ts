import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { Client, Pool, PoolClient } from "pg"
import { db, pool } from "@/db"
import { agents } from "@/db/schema"
import { eq } from "drizzle-orm"
import { env } from "@/lib/env"
import { agentSnapshot } from "@/lib/agent/snapshot"
import { requireReadyWorkflow } from "@/lib/workflows"
import { submitTask } from "@/lib/tasks"
import { parseModelSpec } from "@/lib/providers/catalog"
import { getProviderCredentials } from "@/lib/providers/registry"
import {
  benchmarkCasesSchema,
  benchmarkTaskInput,
  type BenchmarkArm,
  type BenchmarkManifest,
  type BenchmarkTask,
} from "@/lib/workflow-benchmark"

export async function freezeBenchmark(
  ownerId: string,
  agentIds: Record<BenchmarkArm, string>,
  versionId: string,
  cases: unknown
): Promise<BenchmarkManifest> {
  const version = await requireReadyWorkflow(ownerId, versionId)
  if (new Set(Object.values(agentIds)).size !== 3)
    throw new Error(
      "Use three independent desktop workstations so matched paths cannot collide across arms"
    )
  const configs: Awaited<ReturnType<typeof agentSnapshot>>[] = []
  for (const arm of ["baseline", "checked", "repair"] as const) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentIds[arm]))
    if (!agent) throw new Error("Benchmark agent not found")
    configs.push(await agentSnapshot(agent, ownerId))
  }
  if (configs.some((config) => !isDeepStrictEqual(config, configs[0])))
    throw new Error(
      "All benchmark desktops must freeze the same model, instructions, identity and memory"
    )
  const config = configs[0]
  const transport = await getProviderCredentials(parseModelSpec(config.model)!.provider)
  const manifest: BenchmarkManifest = {
    format: 1,
    id: randomUUID(),
    frozenAt: (
      await pool.query("SELECT clock_timestamp() AS now")
    ).rows[0].now.toISOString(),
    database: (await pool.query("SELECT current_database() AS name")).rows[0].name,
    installId: env.INSTALL_ID,
    ownerId,
    agentIds,
    model: config.model,
    providerEndpoint: transport.baseUrl ?? null,
    agentConfig: {
      model: config.model,
      instructions: config.instructions,
      memories: config.memories,
      timeZone: config.timeZone,
      name: config.name,
      role: config.role,
    },
    versionId,
    plan: version.plan!,
    environment: version.validatedEnvironment!,
    coordinateMode: "normalized_1000",
    cases: benchmarkCasesSchema.parse(cases),
    maxSteps: 80,
    maxActions: 120,
    maxDurationSeconds: 300,
    arms: ["baseline", "checked", "repair"],
    uncheckedReplay: "unimplemented",
    population: "ten-new-matched-repetitions-after-exploration",
  }
  const roots: string[] = []
  for (const sample of manifest.cases) {
    const input = benchmarkTaskInput(manifest, "baseline", sample.id)
    roots.push(input.completionContract.directoryTree!.root)
  }
  if (new Set(roots).size !== 10)
    throw new Error(
      "Use ten fresh, distinct parent directories so cases cannot overwrite each other"
    )
  return manifest
}

export async function submitBenchmarkCase(
  manifest: BenchmarkManifest,
  arm: BenchmarkArm,
  caseId: string
) {
  if (
    manifest.installId !== env.INSTALL_ID ||
    manifest.database !==
      (await pool.query("SELECT current_database() AS name")).rows[0].name
  )
    throw new Error(
      "Run the frozen benchmark in its original isolated installation/database"
    )
  if (arm !== "checked") {
    if (manifest.providerEndpoint === undefined)
      throw new Error(
        "This earlier protocol did not freeze a provider endpoint; freeze a new protocol before any model arm"
      )
    const current = await getProviderCredentials(parseModelSpec(manifest.model)!.provider)
    if ((current.baseUrl ?? null) !== manifest.providerEndpoint)
      throw new Error("The benchmark provider endpoint changed after freezing")
  }
  const version = await requireReadyWorkflow(manifest.ownerId, manifest.versionId)
  if (
    !isDeepStrictEqual(version.plan, manifest.plan) ||
    !isDeepStrictEqual(version.validatedEnvironment, manifest.environment)
  )
    throw new Error(
      "Frozen workflow/environment changed; create a new benchmark protocol"
    )
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, manifest.agentIds[arm]))
  const config = await agentSnapshot(agent, manifest.ownerId)
  if (
    !isDeepStrictEqual(
      {
        model: config.model,
        instructions: config.instructions,
        memories: config.memories,
        timeZone: config.timeZone,
        name: config.name,
        role: config.role,
      },
      manifest.agentConfig
    )
  )
    throw new Error("The benchmark model/instructions/memory changed after freezing")
  return submitTask(
    manifest.ownerId,
    `benchmark:${manifest.id}:${arm}`,
    benchmarkTaskInput(manifest, arm, caseId)
  )
}

// Query original journals without screenshots, raw action inputs, model responses
// or credential fields. Contract/parameter metadata stays private. Never reprice history.
export async function readBenchmarkTask(
  client: Client | Pool | PoolClient,
  taskId: string,
  phase: BenchmarkTask["phase"]
): Promise<BenchmarkTask> {
  const row = (
    await client.query(
      `SELECT t.id,t.owner_id,t.source,t.request_key,t.status,t.created_at,t.config_snapshot,t.completion_contract,t.result,
     (SELECT min(created_at) FROM task_events WHERE task_id=t.id AND type IN ('completed','cancelled','failed')) AS terminal_at,
     current_database() AS database FROM tasks t WHERE t.id=$1`,
      [taskId]
    )
  ).rows[0]
  if (!row) throw new Error(`Task not found in the selected evidence database: ${taskId}`)
  const timestamp = (value: Date | null) => value?.toISOString() ?? null
  const attempts = (
    await client.query(
      `SELECT segment_no AS "segmentNo",decision_no AS "decisionNo",attempt_no AS "attemptNo",model,status,usage,
     cost_micros::text AS "costMicros",reconciled_cost_micros::text AS "reconciledCostMicros",price_snapshot AS "priceSnapshot",
     started_at AS "startedAt",finished_at AS "finishedAt" FROM task_model_attempts WHERE task_id=$1 ORDER BY segment_no,decision_no,attempt_no`,
      [taskId]
    )
  ).rows.map((value) => ({
    ...value,
    startedAt: timestamp(value.startedAt)!,
    finishedAt: timestamp(value.finishedAt),
  }))
  const actions = (
    await client.query(
      `SELECT segment_no AS "segmentNo",action_no AS "actionNo",kind,status,boot_id AS "bootId" FROM task_actions WHERE task_id=$1 ORDER BY segment_no,action_no`,
      [taskId]
    )
  ).rows
  const requests = (
    await client.query(
      `SELECT id,kind,status,created_at AS "createdAt",resolved_at AS "resolvedAt" FROM task_requests WHERE task_id=$1 ORDER BY created_at,id`,
      [taskId]
    )
  ).rows.map((value) => ({
    ...value,
    createdAt: timestamp(value.createdAt)!,
    resolvedAt: timestamp(value.resolvedAt),
  }))
  const runTable = (
    await client.query("SELECT to_regclass('task_workflow_runs') AS name")
  ).rows[0].name
  const run = runTable
    ? (
        await client.query(
          "SELECT environment FROM task_workflow_runs WHERE task_id=$1",
          [taskId]
        )
      ).rows[0]
    : null
  const environments = (
    await client.query(
      "SELECT payload->'environment' AS environment FROM task_events WHERE task_id=$1 AND type='desktop_environment' ORDER BY seq",
      [taskId]
    )
  ).rows
  const environment = run?.environment ?? environments[0]?.environment ?? null
  if (environments.some((value) => !isDeepStrictEqual(value.environment, environment)))
    throw new Error(`Desktop image/environment changed within benchmark Task ${taskId}`)
  return {
    taskId,
    database: row.database,
    ownerId: row.owner_id,
    phase,
    status: row.status,
    source: row.source,
    requestKey: row.request_key,
    createdAt: timestamp(row.created_at)!,
    terminalAt: timestamp(row.terminal_at),
    contract: row.completion_contract,
    grade: row.result?.directoryTree?.grade ?? row.result?.verification?.grade ?? null,
    model: row.config_snapshot.model,
    plan: row.config_snapshot.workflowExecution?.plan ?? null,
    parameters: row.config_snapshot.workflowExecution?.parameters ?? null,
    environment,
    workstationChannel: row.config_snapshot.workstationChannel ?? null,
    attempts,
    actions,
    requests,
  }
}
