import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import manifest from "@/app/manifest"

const png = async (path: string) => {
  const data = await readFile(path)
  assert.deepEqual(
    [...data.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  )
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

test("the manifest makes the app installable: name, standalone, start url, 192/512/maskable icons", async () => {
  const m = manifest()
  assert.equal(m.display, "standalone")
  assert.ok(m.name && m.short_name)
  assert.equal(m.start_url, "/companion")
  assert.ok(m.scope === "/" && m.start_url!.startsWith(m.scope))
  assert.match(m.theme_color!, /^#[0-9a-f]{6}$/i)
  assert.match(m.background_color!, /^#[0-9a-f]{6}$/i)
  const icons = m.icons ?? []
  for (const [size, purpose] of [
    [192, "any"],
    [512, "any"],
    [512, "maskable"],
  ] as const) {
    const icon = icons.find((i) => i.sizes === `${size}x${size}` && i.purpose === purpose)
    assert.ok(icon, `${size} ${purpose}`)
    assert.equal(icon.type, "image/png")
    assert.deepEqual(await png(`public${icon.src}`), { width: size, height: size })
  }
  assert.deepEqual(await png("public/icons/apple-touch-icon.png"), {
    width: 180,
    height: 180,
  })
})

test("the service worker only touches page loads and never stores private data", async () => {
  const worker = await readFile("public/sw.js", "utf8")
  assert.match(worker, /request\.mode !== "navigate"\) return/)
  assert.match(worker, /\/offline\.html/)
  // nothing but the fixed shell list is ever written to a cache
  assert.equal((worker.match(/cache\.(put|add)\b/g) ?? []).length, 0)
  assert.equal((worker.match(/addAll\(SHELL\)/g) ?? []).length, 1)
  assert.ok(!/api\//.test(worker))
  const offline = await readFile("public/offline.html", "utf8")
  assert.match(offline, /连不上/)
})

test("layout registers the worker and links the iOS icon", async () => {
  const layout = await readFile("app/layout.tsx", "utf8")
  assert.match(layout, /PwaRegister/)
  assert.match(layout, /apple-touch-icon\.png/)
  assert.match(
    await readFile("Dockerfile", "utf8"),
    /COPY --from=build \/app\/public \.\/public/
  )
})
