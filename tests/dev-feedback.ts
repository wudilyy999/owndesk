// Run with the existing Linux Docker daemon: node --import ./tests/setup-env.mjs --import tsx tests/dev-feedback.ts
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
const tmp = await mkdtemp(path.join(tmpdir(), "owndesk-dev-feedback-"))
process.env.EVOLUTION_DIR = tmp
process.env.INSTALL_ID = randomUUID()
const src = process.env.OWNDESK_TEST_CHECKOUT || process.cwd()
const { developmentPreview } = await import("@/lib/evolution/dev-preview")
const { gitText, patch } = await import("@/lib/evolution/repo")
const { ensureLabImage, startLab, loadCommit, labExec, captureLabCommit, stopLab } =
  await import("@/lib/evolution/lab")
const { docker } = await import("@/lib/docker")
let preview: ReturnType<typeof developmentPreview> | undefined,
  lab: Awaited<ReturnType<typeof startLab>> | undefined
const containers = async () =>
  (
    await docker([
      "ps",
      "-aq",
      "--filter",
      `label=owndesk.dev-preview=${process.env.INSTALL_ID}`,
    ])
  ).stdout
    .toString()
    .trim()
try {
  execFileSync("git", [
    "-c",
    "safe.directory=*",
    "clone",
    "--bare",
    "--quiet",
    src,
    path.join(tmp, "versions.git"),
  ])
  const base = await gitText(["rev-parse", "HEAD"])
  const image = process.env.OWNDESK_TEST_LAB_IMAGE || (await ensureLabImage(base))
  lab = await startLab(image, "feedback")
  await loadCommit(lab, base)
  const check = async (file: string, content: string) => {
    assert.equal((await labExec(lab!, `cat > ${file}`, { input: content })).code, 0)
    return (await labExec(lab!, `node --test ${file}`)).code
  }
  const file = "tests/feedback-fixture.test.mjs"
  assert.notEqual(
    await check(file, "import assert from 'node:assert/strict';assert.equal(1,2)"),
    0
  )
  assert.equal(
    await check(file, "import assert from 'node:assert/strict';assert.equal(2,2)"),
    0
  )
  let commit = await captureLabCommit(lab, base, "feedback")
  assert.match(await patch(base, commit), /feedback-fixture/)
  assert.equal(await containers(), "")
  console.log("logic failed then passed; diff includes new file; no preview services")
  assert.equal((await labExec(lab, "mkdir -p app/dev-diary-fixture")).code, 0)
  const page = (filtered: boolean) =>
    `import {pool} from '@/db';export const dynamic='force-dynamic';export default async function Diary({searchParams}:{searchParams:Promise<{day?:string}>}){const {day}=await searchParams;const r=await pool.query("SELECT title FROM life_activities WHERE kind='diary' ${filtered ? "AND (created_at AT TIME ZONE 'UTC')::date=$1::date" : ""} ORDER BY created_at DESC",${filtered ? "[day]" : "[]"});return <main><form><input aria-label="日期" name="day" type="date" defaultValue={day}/><button>筛选</button></form>{r.rows.map(x=><p key={x.title}>{x.title}</p>)}</main>}`
  preview = developmentPreview(image)
  const probe = {
    path: "/dev-diary-fixture?day=" + new Date().toISOString().slice(0, 10),
    actions: [
      {
        action: "fill" as const,
        selector: "input[name=day]",
        value: new Date().toISOString().slice(0, 10),
      },
      { action: "click" as const, selector: "button" },
    ],
    contains: "公园散步",
    absent: "番茄炒蛋",
  }
  let identity = ""
  for (const fixed of [false, true]) {
    assert.equal(
      (await labExec(lab, "cat > app/dev-diary-fixture/page.tsx", { input: page(fixed) }))
        .code,
      0
    )
    commit = await captureLabCommit(lab, commit, "feedback")
    const tree = await gitText(["rev-parse", `${commit}^{tree}`])
    const start = Date.now()
    const result: { ok: boolean; output: string } = await preview.check(
      commit,
      tree,
      probe
    )
    console.log(
      `preview ${fixed ? "edited" : "initial"}: ${Date.now() - start} ms; observed ${result.output}`
    )
    assert.equal(result.ok, fixed)
    if (!fixed) {
      const second = developmentPreview(image)
      await assert.rejects(second.check(commit, tree, probe), /另一个改进/)
      await second.close()
    }
    assert.match(result.output, /公园散步/)
    const ids = (await containers()).split(/\s+/).sort().join(",")
    if (identity) assert.equal(ids, identity)
    identity = ids
    const peaks = await Promise.all(
      ids
        .split(",")
        .map(async (id) =>
          Number(
            (await docker(["exec", id, "cat", "/sys/fs/cgroup/memory.peak"])).stdout
              .toString()
              .trim()
          )
        )
    )
    console.log(
      "sum of per-container peak MiB (upper bound):",
      Math.round(peaks.reduce((a, b) => a + b, 0) / 1048576)
    )
    assert.equal(
      (
        await docker([
          "inspect",
          "--format",
          "{{.HostConfig.NetworkMode}}",
          `pa-${process.env.INSTALL_ID}-dev-db`,
        ])
      ).stdout
        .toString()
        .trim(),
      "none"
    )
  }
  await preview.close()
  assert.equal(await containers(), "")
  console.log("same containers; no external network; cleanup passed")
  if (process.argv.includes("--release")) {
    // Use the shipping build stage; verify the production response in a fresh database,
    // without reading any preview state or the reformer's receipts.
    await stopLab(lab)
    lab = undefined
    const { buildStage } = await import("@/lib/evolution/evaluator")
    const { previewSeed } = await import("@/lib/evolution/snapshot")
    const tag = `feedback-${process.env.INSTALL_ID!.slice(0, 8)}`,
      pg = tag + "-pg",
      web = tag + "-web"
    const { result, images } = await buildStage(base, commit, tag, () => {})
    const { dockerRaw } = await import("@/lib/docker")
    try {
      assert.equal(result.status, "pass", result.detail)
      const seed = await previewSeed()
      const args = [
        "--env",
        "DATABASE_URL=postgresql://agent:fixture@127.0.0.1:5432/agent",
        "--env",
        "APP_URL=http://127.0.0.1:6797",
        "--env",
        `INSTALL_ID=${randomUUID()}`,
        "--env",
        `MASTER_KEY=${"0".repeat(64)}`,
        "--env",
        `BETTER_AUTH_SECRET=${randomUUID()}`,
      ]
      await docker([
        "run",
        "-d",
        "--name",
        pg,
        "--network",
        "none",
        "-e",
        "POSTGRES_USER=agent",
        "-e",
        "POSTGRES_PASSWORD=fixture",
        process.env.PA_POSTGRES_IMAGE || "postgres:16.15-alpine",
      ])
      await docker([
        "exec",
        pg,
        "sh",
        "-ec",
        "for i in $(seq 1 45); do pg_isready -h 127.0.0.1 -U agent && exit 0; sleep 1; done; exit 1",
      ])
      await docker([
        "run",
        "--rm",
        "--network",
        `container:${pg}`,
        ...args,
        images.worker,
        "npm",
        "run",
        "db:migrate",
      ])
      await docker(
        ["exec", "-i", pg, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "agent"],
        { input: seed.sql }
      )
      await docker([
        "run",
        "-d",
        "--name",
        web,
        "--network",
        `container:${pg}`,
        ...args,
        images.web,
      ])
      await docker(
        [
          "exec",
          "-i",
          web,
          "node",
          "--input-type=module",
          "-e",
          `import assert from 'node:assert/strict';let input='';for await(const c of process.stdin)input+=c;const login=JSON.parse(input);const url='http://127.0.0.1:6797';let r;for(let i=0;i<60;i++){try{r=await fetch(url+'/login');if(r.ok)break}catch{}await new Promise(r=>setTimeout(r,500))}const auth=await fetch(url+'/api/auth/sign-in/email',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify(login)});assert.equal(auth.status,200);const response=await fetch(url+${JSON.stringify(probe.path)},{headers:{Cookie:auth.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')}});assert.equal(response.status,200);const body=await response.text();assert.ok(body.includes('公园散步'));assert.ok(!body.includes('番茄炒蛋'));`,
        ],
        { input: JSON.stringify(seed.login), timeoutMs: 120000 }
      )
      console.log(
        "release: exact final commit built as Web + Worker; fresh signed-in production page independently confirmed the date filter"
      )
    } finally {
      await dockerRaw(["rm", "-fv", web, pg])
      await dockerRaw(["image", "rm", images.web, images.worker])
    }
  }
} finally {
  await preview?.close()
  if (lab) await stopLab(lab)
  await rm(tmp, { recursive: true, force: true })
}
