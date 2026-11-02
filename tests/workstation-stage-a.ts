import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { docker } from "@/lib/docker"
import { workstationImage } from "./workstation-image"

// Stage A acceptance on a real workstation container: Chinese locale and fonts,
// pinyin input, LibreOffice, Chromium policy, on-demand app packs and agent control.
// STAGE_A_APT_MIRROR=http://host:port rewrites the container's apt source for
// networks where deb.debian.org is not reachable directly.
const image = process.env.STAGE_A_IMAGE ?? workstationImage
const directory = path.resolve(
  process.argv[2] ?? `data/experiments/workstation-stage-a-${Date.now()}`
)
await mkdir(directory, { recursive: true })
const names = [`pa-stagea-${Date.now()}`, `pa-stagea-en-${Date.now()}`]
const [container, english] = names
const checks: string[] = []
let passed = false

// A docker exec session lacks the desktop's session bus, which the agent's own shell has
// (the controller starts inside it), so borrow it from the controller process
const session =
  'export $(tr "\\0" "\\n" < /proc/$(pgrep -f "^node.*owndesk-controller/server" | head -1)/environ | grep -E "^(DBUS_SESSION_BUS_ADDRESS|DISPLAY)=");'
const sh = async (c: string, script: string, user = "agent", timeoutMs = 120000) =>
  (
    await docker(["exec", "--user", user, c, "bash", "-lc", `${session} ${script}`], {
      timeoutMs,
    })
  ).stdout
    .toString()
    .trim()
async function start(name: string, extra: string[] = []) {
  await docker(
    [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "personal-agent.experiment=workstation-stage-a",
      "--cpus",
      "2",
      "--memory",
      "4g",
      "--shm-size",
      "1g",
      "--env",
      "PA_WORKSPACE_TOKEN",
      "--env",
      "OWNDESK_VNC_PASSWORD",
      "--env",
      "OWNDESK_IDLE_MINUTES=0",
      ...extra,
      image,
    ],
    {
      env: {
        PA_WORKSPACE_TOKEN: randomBytes(32).toString("hex"),
        OWNDESK_VNC_PASSWORD: randomBytes(12).toString("hex"),
      },
    }
  )
  await docker(["exec", name, "owndesk-ready"], { timeoutMs: 60000 })
}
async function shot(file: string) {
  await sh(container, `DISPLAY=:1 scrot -o /tmp/${file}`)
  await docker(["cp", `${container}:/tmp/${file}`, path.join(directory, file)])
}
async function request(route: string, body: unknown) {
  const result = await docker(
    ["exec", "-i", container, "node", "/opt/owndesk-controller/request.mjs", route],
    { input: JSON.stringify(body), maxOutputBytes: 6000000 }
  )
  return JSON.parse(result.stdout.toString())
}
async function windowTitles() {
  return sh(
    container,
    "DISPLAY=:1 xdotool search --onlyvisible --name . getwindowname %@ 2>/dev/null || true"
  )
}
async function waitWindow(pattern: RegExp, seconds = 90) {
  for (let i = 0; i < seconds * 2; i++) {
    if (pattern.test(await windowTitles())) return
    await delay(500)
  }
  throw new Error(`No window matching ${pattern}`)
}

try {
  await start(container)

  // 1. Chinese locale, time zone and translations that survive the slim base image
  assert.equal(await sh(container, "echo $LANG"), "zh_CN.UTF-8")
  assert.equal(await sh(container, "date +%Z"), "CST")
  assert.match(await sh(container, "date +%A"), /星期/)
  assert(
    Number(await sh(container, "ls /usr/share/locale/zh_CN/LC_MESSAGES | wc -l")) > 20
  )
  assert.match(await sh(container, "fc-match 'sans:lang=zh-cn'"), /CJK/)
  assert(Number(await sh(container, "fc-list :lang=zh-cn | wc -l")) > 3)
  checks.push("zh_CN.UTF-8 locale, CST, Chinese gettext catalogs and Noto CJK fonts")

  // 2. The desktop: wallpaper, Chinese launchers, glyph rendering
  await delay(4000)
  await shot("desktop.png")
  const desktop = await sh(container, "ls ~/Desktop")
  for (const launcher of [
    "owndesk-browser",
    "owndesk-writer",
    "owndesk-calc",
    "owndesk-life",
    "owndesk-web-bilibili",
    "owndesk-web-netease-music",
  ])
    assert(desktop.includes(`${launcher}.desktop`), launcher)
  assert.match(await sh(container, "cat ~/.local/share/owndesk/wallpaper"), /wallpaper/)
  assert(
    (await readFile(path.join(directory, "desktop.png"))).byteLength > 20000,
    "desktop screenshot looks empty"
  )
  checks.push("Chinese desktop with wallpaper and seeded launchers (desktop.png)")

  // 3. fcitx5 pinyin: real key events into Mousepad, saved to a file to read back
  await sh(container, "(DISPLAY=:1 mousepad >/tmp/mousepad.log 2>&1 &)")
  await waitWindow(/Mousepad/, 30)
  await delay(4000)
  const x = "DISPLAY=:1 xdotool"
  await sh(container, `${x} mousemove 640 400 click 1`)
  await delay(500)
  await sh(container, `${x} key ctrl+space`)
  await delay(800)
  assert.equal(await sh(container, "fcitx5-remote || true"), "2", "pinyin not active")
  await sh(container, `${x} type --delay 120 nihao`)
  await delay(800)
  await shot("pinyin-candidates.png")
  await sh(container, `${x} key space`)
  await delay(500)
  await sh(container, `${x} key ctrl+space`) // back to the English keyboard
  await delay(500)
  await sh(container, `${x} key ctrl+s`)
  await waitWindow(/另存为/, 20)
  await delay(1500)
  await sh(container, `${x} type --delay 60 /tmp/ime.txt`)
  await delay(1000)
  await sh(container, `${x} key Return`)
  for (
    let i = 0;
    i < 20 && (await sh(container, "ls /tmp/ime.txt 2>/dev/null || true")) === "";
    i++
  )
    await delay(500)
  assert.equal((await sh(container, "cat /tmp/ime.txt")).trim(), "你好")
  await sh(container, "pkill -x mousepad || true")
  checks.push("fcitx5 pinyin types 你好 into a GTK program (pinyin-candidates.png)")

  // 4. LibreOffice: headless conversion with Chinese text, then the real window
  await sh(container, "printf '你好，世界\\n' > /tmp/hello.txt")
  await sh(
    container,
    "cd /tmp && soffice --headless --convert-to pdf hello.txt >/dev/null 2>&1",
    "agent",
    180000
  )
  assert.equal(await sh(container, "head -c 4 /tmp/hello.pdf"), "%PDF")
  await sh(container, "(DISPLAY=:1 libreoffice --writer >/tmp/lo.log 2>&1 &)")
  await waitWindow(/LibreOffice Writer/, 90)
  await delay(4000)
  await shot("libreoffice.png")
  await sh(container, "pkill -x soffice.bin || true")
  checks.push(
    "LibreOffice Writer converts Chinese text to PDF and opens a window (libreoffice.png)"
  )

  // 5. Chromium: policies, Chinese UI language, Chinese default search, web-app launcher
  await sh(container, "browser https://example.com/")
  await delay(4000)
  const policy = JSON.parse(
    await sh(container, "cat /etc/chromium/policies/managed/owndesk-web.json")
  )
  assert(JSON.stringify(policy.ManagedBookmarks).includes("bilibili.com"))
  await sh(
    container,
    `cat > /tmp/p.mjs <<'JS'
import { chromium } from "/opt/owndesk-controller/node_modules/playwright-core/index.mjs"
const b = await chromium.connectOverCDP("http://127.0.0.1:9222")
const p = await b.contexts()[0].newPage()
await p.goto("chrome://policy")
await p.waitForTimeout(2500)
const managed = await p.locator("text=ManagedBookmarks").count()
const search = await p.locator("text=DefaultSearchProviderSearchURL").count()
const language = await p.evaluate(() => navigator.language)
await p.close()
await b.close()
console.log(JSON.stringify({ managed, search, language }))
JS
node /tmp/p.mjs`
  ).then((out) => {
    const seen = JSON.parse(out.split("\n").pop()!)
    assert(seen.managed > 0 && seen.search > 0, out)
    assert.equal(seen.language, "zh-CN")
  })
  await sh(container, `${x} key ctrl+l`)
  await sh(container, `${x} type --delay 60 'owndesk test'`)
  await sh(container, `${x} key Return`)
  await delay(5000)
  const targets = await sh(container, "curl -s http://127.0.0.1:9222/json")
  assert(/baidu\.com/.test(targets), "default search did not go to Baidu")
  await shot("chromium.png")
  await sh(container, "(owndesk-webapp https://music.163.com/ >/tmp/webapp.log 2>&1 &)")
  await waitWindow(/网易云音乐/, 60)
  await shot("webapp.png")
  checks.push(
    "Chromium applies managed bookmarks, Baidu default search and zh-CN; 网易云 web app opens in its own window (chromium.png, webapp.png)"
  )

  // 6. On-demand app packs
  const mirror = process.env.STAGE_A_APT_MIRROR
  if (mirror)
    await sh(
      container,
      `sed -i 's#http://deb.debian.org#${mirror}#' /etc/apt/sources.list.d/debian.sources`,
      "root"
    )
  const list = await sh(container, "owndesk-apps list")
  for (const pack of ["office", "media", "creative", "games"])
    assert(list.includes(pack), pack)
  assert.match(list, /office\s+已内置/)
  assert.match(list, /games\s+未安装/)
  await sh(container, "owndesk-apps install games", "agent", 600000)
  assert.match(await sh(container, "owndesk-apps list"), /games\s+已安装/)
  assert.match(await sh(container, "dpkg -s gnome-mines"), /Status: install ok installed/)
  assert((await sh(container, "ls ~/Desktop")).includes("org.gnome.Mines.desktop"))
  await sh(container, "owndesk-apps install games", "agent", 120000) // idempotent
  await assert.rejects(sh(container, "owndesk-apps install '../etc/passwd'"))
  checks.push(
    "owndesk-apps lists packs, installs games with desktop icons, repeats safely and rejects bad names"
  )

  // 7. Agent desktop control: the native controller still observes and acts
  await sh(
    container,
    "pkill -f '[-]-user-data-dir=/home/agent/.config/owndesk-webapps' || true"
  )
  await request("/control", { epoch: 1, mode: "agent" })
  async function action(kind: string, params: Record<string, unknown>) {
    const id = randomUUID()
    await request("/actions", { id, kind, params })
    for (let i = 0; i < 200; i++) {
      const receipt = await request("/action-status", { id })
      if (["succeeded", "rejected", "unknown"].includes(receipt.status)) return receipt
      await delay(50)
    }
    throw new Error(`Action ${kind} did not finish`)
  }
  const capture = await action("screen_capture", { epoch: 1 })
  assert.equal(capture.status, "succeeded", capture.error)
  assert(capture.result.image)
  const thunar = await action("desktop_open_application", {
    epoch: 1,
    application: "Thunar",
  })
  assert.equal(thunar.status, "succeeded", thunar.error)
  assert.equal(
    thunar.result.accessibility.status,
    "ok",
    JSON.stringify(thunar.result.accessibility)
  )
  assert(
    thunar.result.elements.some((item: any) => /^文件\(F\)$/.test(item.name)),
    "Thunar controls are not exposed through AT-SPI"
  )
  const windows = await action("desktop_list_windows", { epoch: 1 })
  assert.equal(windows.status, "succeeded", windows.error)
  assert(windows.result.windows.some((w: any) => /Thunar/.test(w.app_name)))
  await shot("agent-thunar.png")
  checks.push(
    "agent control: screenshot, Thunar opened by the controller, Chinese control names and windows via AT-SPI (agent-thunar.png)"
  )

  // 8. Locale and time zone overrides (WORKSTATION_LOCALE / WORKSTATION_TZ)
  await start(english, [
    "--env",
    "LANG=en_US.UTF-8",
    "--env",
    "LANGUAGE=en_US",
    "--env",
    "TZ=America/New_York",
  ])
  assert.equal(await sh(english, "echo $LANG"), "en_US.UTF-8")
  assert.match(await sh(english, "date +%Z"), /^E[SD]T$/)
  assert.match(await sh(english, "date +%A"), /day$/)
  checks.push(
    "LANG/LANGUAGE/TZ overrides switch the workstation to English and New York time"
  )
  passed = true
} finally {
  if (!passed) await shot("failure.png").catch(() => {})
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify({ passed, image, checks, testedAt: new Date().toISOString() }, null, 2)
  )
  for (const name of names) await docker(["rm", "-f", name]).catch(() => {})
}
console.log(JSON.stringify({ passed, directory, image, checks }, null, 2))
