import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { localeArgs } from "@/lib/workstation"

const share = "workstation/rootfs/usr/share/owndesk"
const bin = "workstation/rootfs/usr/local/bin"

function conf(file: string) {
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(?:"(.*)"|(\S*))\s*$/.exec(line)
    if (m) out[m[1]] = m[2] ?? m[3]
  }
  return out
}

test("every app pack manifest is complete and uses installable package names", () => {
  const dir = path.join(share, "apps.d")
  const packs = readdirSync(dir).filter((f) => f.endsWith(".conf"))
  assert(packs.length >= 5)
  for (const file of packs) {
    assert.match(file.replace(/\.conf$/, ""), /^[a-z0-9-]+$/, file)
    const pack = conf(path.join(dir, file))
    assert(pack.TITLE && pack.DESCRIPTION, file)
    if (pack.BUILTIN === "1") continue
    assert.match(
      pack.PACKAGES ?? "",
      /^[a-z0-9][a-z0-9+.-]*( [a-z0-9][a-z0-9+.-]*)*$/,
      file
    )
    assert(pack.LAUNCHERS !== undefined, file)
  }
  for (const wanted of ["office", "media", "creative", "games"])
    assert(existsSync(path.join(dir, `${wanted}.conf`)), wanted)
})

test("owndesk-gen-web writes web app launchers and Chromium policy for Chinese users", () => {
  const out = mkdtempSync(path.join(tmpdir(), "owndesk-gen-web-"))
  execFileSync("node", [
    path.join(bin, "owndesk-gen-web"),
    "--share",
    share,
    "--apps",
    path.join(out, "apps"),
    "--policy",
    path.join(out, "policy"),
  ])
  const bilibili = readFileSync(
    path.join(out, "apps/owndesk-web-bilibili.desktop"),
    "utf8"
  )
  assert.match(bilibili, /^Name=哔哩哔哩$/m)
  assert.match(bilibili, /^Exec=owndesk-webapp https:\/\/www\.bilibili\.com\/$/m)
  assert(existsSync(path.join(out, "apps/owndesk-web-netease-music.desktop")))
  const policy = JSON.parse(
    readFileSync(path.join(out, "policy/owndesk-web.json"), "utf8")
  )
  assert.equal(policy.BookmarkBarEnabled, true)
  assert.equal(policy.DefaultSearchProviderEnabled, true)
  assert.match(policy.DefaultSearchProviderSearchURL, /^https:\/\/.+\{searchTerms\}/)
  const urls = JSON.stringify(policy.ManagedBookmarks)
  assert(urls.includes("https://www.bilibili.com/") && urls.includes("music.163.com"))
  for (const icon of readdirSync(path.join(share, "../icons/hicolor/scalable/apps")))
    assert(icon.endsWith(".svg"))
})

test("the desktop seeds only launchers that exist", () => {
  const ids = readFileSync(path.join(share, "desktop/seed.list"), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
  for (const id of ids) {
    const ours = existsSync(path.join(share, "desktop", `${id}.desktop`))
    const web =
      id.startsWith("owndesk-web-") &&
      existsSync(path.join(share, "web.d", `${id.slice(12)}.conf`))
    assert(ours || web, id)
  }
})

test("workstation locale overrides are passed to docker only when configured", () => {
  const args = localeArgs()
  // setup-env leaves both unset, so the image keeps zh_CN.UTF-8 / Asia/Shanghai
  assert.deepEqual(args, [])
})
