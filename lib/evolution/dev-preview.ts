// Trusted controller for one disposable development preview per installation. All processes
// share only the loopback namespace of the synthetic DB. No published ports or host mounts.
import { randomBytes, randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { docker, dockerRaw } from "@/lib/docker"
import { env } from "@/lib/env"
import { archive } from "./repo"
import { previewSeed, type SnapshotLogin } from "./snapshot"

export const previewInput = z.object({
  path: z
    .string()
    .max(500)
    .refine(
      (p) =>
        p.startsWith("/") &&
        !p.startsWith("//") &&
        !p.includes("\\") &&
        Array.from(p).every((c) => c.charCodeAt(0) > 32)
    ),
  actions: z
    .array(
      z.discriminatedUnion("action", [
        z.object({ action: z.literal("click"), selector: z.string().min(1).max(300) }),
        z.object({
          action: z.literal("fill"),
          selector: z.string().min(1).max(300),
          value: z.string().max(500),
        }),
      ])
    )
    .max(8)
    .default([]),
  contains: z.string().trim().min(1).max(300),
  absent: z.string().trim().min(1).max(300).optional(),
})
export type PreviewInput = z.infer<typeof previewInput>
const label = () => `owndesk.dev-preview=${env.INSTALL_ID}`
const prefix = () => `pa-${env.INSTALL_ID}-dev`
let occupied = false

// Called after acquiring the existing single-worker database lease or by the owning round.
export async function clearDevPreview() {
  const ids = (await docker(["ps", "-aq", "--filter", `label=${label()}`])).stdout
    .toString()
    .trim()
  if (ids) await docker(["rm", "-fv", ...ids.split(/\s+/)])
}

// The program and Chromium live in the trusted workstation image. Model input is JSON data.
const observe = `import { chromium } from '/opt/owndesk-controller/node_modules/playwright-core/index.mjs';
let raw=''; for await (const x of process.stdin) raw+=x;
const {login,probe}=JSON.parse(raw), base='http://127.0.0.1:6797';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
try {
 const context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*', r=> new URL(r.request().url()).origin===base ? r.continue() : r.abort());
 const auth=await context.request.post(base+'/api/auth/sign-in/email',{data:login,headers:{Origin:base},timeout:90000});
 if(!auth.ok()) throw Error('preview sign-in HTTP '+auth.status());
 const page=await context.newPage(); page.setDefaultTimeout(8000);
 const res=await page.goto(new URL(probe.path,base).href,{waitUntil:'domcontentloaded',timeout:90000});
 if(!res?.ok()) throw Error('preview page HTTP '+res?.status());
 for(const a of probe.actions){const field=page.locator(a.selector);if(a.action==='fill') await field.fill(a.value);else await field.click();}
 let ok=true;try {await page.waitForFunction(({contains,absent})=>{const t=document.body.innerText;return t.includes(contains)&&(!absent||!t.includes(absent))},probe,{timeout:8000});} catch {ok=false;}
 const text=(await page.locator('body').innerText()).slice(0,4000);
 console.log(JSON.stringify({ok,output:JSON.stringify({path:new URL(page.url()).pathname,text})}));
} finally {await browser.close()}`

export function developmentPreview(image: string) {
  const pg = prefix() + "-db",
    web = prefix() + "-web",
    browser = prefix() + "-browser"
  let owned = false,
    loaded = "",
    login: SnapshotLogin | undefined
  const common = [
    "--detach",
    "--label",
    label(),
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "512",
  ]
  async function close() {
    if (!owned) return
    try {
      await clearDevPreview()
    } finally {
      owned = false
      occupied = false
      loaded = ""
      login = undefined
    }
  }
  async function check(commit: string, tree: string, probe: PreviewInput) {
    if (!owned && occupied) throw Error("另一个改进正在预览，请稍后重试")
    if (!owned) {
      owned = true
      occupied = true
    }
    try {
      if (!login) {
        await clearDevPreview()
        const password = randomBytes(20).toString("hex")
        await docker([
          "run",
          ...common,
          "--network",
          "none",
          "--memory",
          "384m",
          "--name",
          pg,
          "--env",
          "POSTGRES_USER=agent",
          "--env",
          "POSTGRES_DB=personal_agent",
          "--env",
          `POSTGRES_PASSWORD=${password}`,
          process.env.PA_POSTGRES_IMAGE || "postgres:16.15-alpine",
        ])
        const network = ["--network", `container:${pg}`, "--cap-drop", "ALL"]
        await docker([
          "run",
          ...common,
          ...network,
          "--name",
          web,
          "--cpus",
          "2",
          "--memory",
          "2048m",
          "--env",
          `DATABASE_URL=postgresql://agent:${password}@127.0.0.1:5432/personal_agent`,
          "--env",
          "APP_URL=http://127.0.0.1:6797",
          "--env",
          `MASTER_KEY=${randomBytes(32).toString("hex")}`,
          "--env",
          `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`,
          "--env",
          `INSTALL_ID=${randomUUID()}`,
          image,
          "sleep",
          "infinity",
        ])
        await docker([
          "run",
          ...common,
          ...network,
          "--name",
          browser,
          "--memory",
          "768m",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,exec,size=256m",
          "--shm-size",
          "128m",
          "--env",
          "HOME=/tmp",
          "--entrypoint",
          "sleep",
          env.WORKSTATION_IMAGE,
          "infinity",
        ])
        let ready = false
        for (let i = 0; i < 45; i++) {
          if (
            (
              await dockerRaw([
                "exec",
                pg,
                "pg_isready",
                "-h",
                "127.0.0.1",
                "-U",
                "agent",
              ])
            ).exitCode === 0
          ) {
            ready = true
            break
          }
          await delay(1000)
        }
        if (!ready) throw Error("预览数据库未就绪")
      }
      if (loaded !== tree) {
        // Replace the source directory, including deletions. Restart the dev process so an
        // old compiled page cannot be mistaken for evidence about the new tree.
        if (loaded) await docker(["restart", "-t", "1", web])
        await docker(["exec", web, "sh", "-ec", "rm -rf /lab/src; mkdir /lab/src"])
        await docker(["exec", "-i", "-w", "/lab/src", web, "tar", "-xf", "-"], {
          input: await archive(commit),
          timeoutMs: 120000,
        })
        await docker([
          "exec",
          web,
          "ln",
          "-s",
          "/lab/node_modules",
          "/lab/src/node_modules",
        ])
        if (!login) {
          await docker(["exec", "-w", "/lab/src", web, "npm", "run", "db:migrate"], {
            timeoutMs: 120000,
          })
          const seed = await previewSeed()
          await docker(
            [
              "exec",
              "-i",
              pg,
              "psql",
              "-q",
              "-v",
              "ON_ERROR_STOP=1",
              "-U",
              "agent",
              "-d",
              "personal_agent",
            ],
            { input: seed.sql }
          )
          login = seed.login
        }
        await docker([
          "exec",
          "-d",
          "-w",
          "/lab/src",
          web,
          "sh",
          "-c",
          `exec node node_modules/next/dist/bin/next dev --webpack -H 127.0.0.1 -p 6797 >/tmp/dev.log 2>&1`,
        ])
        await docker(
          [
            "exec",
            web,
            "node",
            "-e",
            `(async()=>{for(let i=0;i<90;i++){try{const r=await fetch('http://127.0.0.1:6797/login',{signal:AbortSignal.timeout(45000)});if(r.ok)return}catch{}await new Promise(r=>setTimeout(r,500))}process.exit(1)})()`,
          ],
          { timeoutMs: 150000 }
        )
        loaded = tree
      }
      const res = await docker(
        ["exec", "-i", browser, "node", "--input-type=module", "-e", observe],
        {
          input: JSON.stringify({ login, probe: previewInput.parse(probe) }),
          timeoutMs: 240000,
          maxOutputBytes: 64000,
        }
      )
      return z
        .object({ ok: z.boolean(), output: z.string() })
        .parse(JSON.parse(res.stdout.toString()))
    } catch (e) {
      await close()
      throw e
    }
  }
  return { check, close }
}
