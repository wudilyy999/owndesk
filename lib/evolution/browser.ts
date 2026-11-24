// The trusted reviewer reuses the installed workstation's Chromium and Playwright.
// Its disposable browser has only the synthetic candidate network and no data volumes.
import { setTimeout as delay } from "node:timers/promises"
import { chromium } from "playwright"
import { docker, dockerRaw } from "@/lib/docker"
import { env } from "@/lib/env"
import { LAB_LABEL } from "@/lib/evolution/lab"
import type { CandidateStack } from "@/lib/evolution/evaluator"

export async function startReviewBrowser(
  stack: Pick<CandidateStack, "network" | "appUrl" | "containers" | "key">
) {
  const name = stack.containers.web.replace(/-web$/, "-review")
  await dockerRaw(["rm", "-f", name])
  try {
    await docker([
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      stack.network,
      "--label",
      `${LAB_LABEL}=${env.INSTALL_ID}`,
      "--label",
      `owndesk.lab.stack=${stack.key}`,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,size=256m",
      "--shm-size",
      "256m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--memory",
      "1024m",
      "--cpus",
      "1",
      "--pids-limit",
      "512",
      "--env",
      "HOME=/tmp",
      "--entrypoint",
      "node",
      env.WORKSTATION_IMAGE,
      "--input-type=module",
      "-e",
      `import { chromium } from '/opt/owndesk-controller/node_modules/playwright-core/index.mjs';
       import net from 'node:net';
       await chromium.launchPersistentContext('/tmp/profile', { executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=9222', ${JSON.stringify(`--unsafely-treat-insecure-origin-as-secure=${stack.appUrl}`)}] });
       const proxy = net.createServer(socket => {
         const upstream = net.connect(9222, '127.0.0.1');
         socket.pipe(upstream).pipe(socket);
         socket.on('error', () => upstream.destroy());
         upstream.on('error', () => socket.destroy());
       });
       await new Promise(resolve => proxy.listen(9232, '0.0.0.0', resolve));
       const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
       const endpoint = new URL(version.webSocketDebuggerUrl);
       endpoint.hostname = '0.0.0.0'; endpoint.port = '9232';
       console.log(endpoint.toString());`,
    ])
    let endpoint = ""
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const logged = await dockerRaw(["logs", name])
      const logs = logged.stdout.toString()
      endpoint = /ws:\/\/[^\s]+/.exec(logs)?.[0] ?? ""
      if (endpoint) break
      const running = (
        await docker(["inspect", "--format", "{{.State.Running}}", name])
      ).stdout
        .toString()
        .trim()
      if (running !== "true")
        throw new Error(`候选评审浏览器启动失败：${logged.stderr.slice(-3000)}`)
      await delay(500)
    }
    if (!endpoint) throw new Error("候选评审浏览器启动超时")
    const ip = (
      await docker([
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${stack.network}").IPAddress}}`,
        name,
      ])
    ).stdout
      .toString()
      .trim()
    const url = new URL(endpoint)
    url.hostname = ip
    const browser = await chromium.connectOverCDP(url.toString(), { timeout: 30000 })
    return {
      browser,
      endpoint: url.toString(),
      close: async () => {
        try {
          await browser.close()
        } finally {
          await dockerRaw(["rm", "-f", name])
        }
      },
    }
  } catch (error) {
    await dockerRaw(["rm", "-f", name])
    throw error
  }
}
