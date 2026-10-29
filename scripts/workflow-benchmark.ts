import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { z } from "zod"
import {
  benchmarkArmSchema,
  benchmarkCasesSchema,
  benchmarkReport,
  uniqueBenchmarkTasks,
  type BenchmarkManifest,
  type BenchmarkTask,
} from "@/lib/workflow-benchmark"

process.loadEnvFile(".env")
const [command, file, argument, extra, last] = process.argv.slice(2)
const { pool } = await import("@/db")
const { closeDurableClient } = await import("@/lib/durable")
const { freezeBenchmark, readBenchmarkTask, submitBenchmarkCase } =
  await import("@/lib/workflow-benchmark-db")
try {
  if (command === "freeze") {
    const spec = z
      .strictObject({
        ownerId: z.string().min(1),
        versionId: z.string().min(1),
        agentIds: z.strictObject({
          baseline: z.string().min(1),
          checked: z.string().min(1),
          repair: z.string().min(1),
        }),
        cases: benchmarkCasesSchema,
      })
      .parse(JSON.parse(await readFile(file, "utf8")))
    const manifest = await freezeBenchmark(
      spec.ownerId,
      spec.agentIds,
      spec.versionId,
      spec.cases
    )
    await mkdir(argument, { recursive: true })
    const output = path.resolve(argument, "manifest.json")
    await writeFile(output, JSON.stringify(manifest, null, 2), {
      flag: "wx",
      mode: 0o600,
    })
    console.log(
      JSON.stringify({
        id: manifest.id,
        manifest: output,
        cases: manifest.cases.length,
        submitted: 0,
      })
    )
  } else if (command === "submit") {
    // Manifests are private, locally generated artifacts, not community packages.
    // Admission rechecks their installation, ready plan, owner and frozen config.
    const manifest = JSON.parse(await readFile(file, "utf8")) as BenchmarkManifest
    console.log(
      JSON.stringify(
        await submitBenchmarkCase(manifest, benchmarkArmSchema.parse(argument), extra)
      )
    )
  } else if (command === "collect") {
    const refs = z
      .array(
        z.strictObject({
          database: z.string().regex(/^[a-z][a-z0-9_]{0,100}$/),
          taskId: z.string().min(1).max(100),
          phase: z.enum([
            "exploration",
            "compilation",
            "validation",
            "execution",
            "repair",
            "control",
            "ui",
          ]),
        })
      )
      .min(1)
      .max(500)
      .parse(JSON.parse(await readFile(file, "utf8")))
    const tasks: BenchmarkTask[] = []
    for (const name of new Set(refs.map((ref) => ref.database))) {
      const url = new URL(process.env.DATABASE_URL!)
      url.pathname = `/${name}`
      const client = new pg.Client({ connectionString: url.toString() })
      await client.connect()
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        for (const ref of refs.filter((ref) => ref.database === name))
          tasks.push(await readBenchmarkTask(client, ref.taskId, ref.phase))
        await client.query("COMMIT")
      } finally {
        await client.end()
      }
    }
    const unique = uniqueBenchmarkTasks(tasks)
    await writeFile(argument, JSON.stringify(unique, null, 2), {
      flag: "wx",
      mode: 0o600,
    })
    console.log(
      JSON.stringify({
        tasks: unique.length,
        selectedReferences: refs.length,
        output: path.resolve(argument),
      })
    )
  } else if (command === "report") {
    const manifest = JSON.parse(await readFile(file, "utf8")) as BenchmarkManifest
    const setup = JSON.parse(await readFile(argument, "utf8")) as BenchmarkTask[]
    const ids = (
      await pool.query(
        "SELECT id FROM tasks WHERE source=ANY($1::text[]) ORDER BY created_at",
        [manifest.arms.map((arm) => `benchmark:${manifest.id}:${arm}`)]
      )
    ).rows
    const samples = []
    for (const row of ids)
      samples.push(await readBenchmarkTask(pool, row.id, "execution"))
    const report = benchmarkReport(
      manifest,
      setup,
      samples,
      new Date().toISOString(),
      last ?? null
    )
    await writeFile(
      extra,
      JSON.stringify({ manifest, report, setup, samples }, null, 2),
      { flag: "wx", mode: 0o600 }
    )
    console.log(
      JSON.stringify({
        comparable: report.comparable,
        fullC4Accepted: report.fullC4Accepted,
        violations: report.violations,
        output: path.resolve(extra),
      })
    )
  } else
    throw new Error(
      "Use freeze SPEC.json DIRECTORY | submit MANIFEST.json baseline|checked|repair CASE_ID | collect REFS.json OUTPUT.json | report MANIFEST.json SETUP.json OUTPUT.json [SHARED_FIRST_TASK_ID]"
    )
} finally {
  await closeDurableClient()
  await pool.end()
}
