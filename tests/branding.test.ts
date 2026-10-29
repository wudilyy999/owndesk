import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

test("OwnDesk runtime files and paths use the independent product name", async () => {
  const provenance = JSON.parse(await readFile("provenance.json", "utf8"))
  const upstreamName = new URL(provenance.repository).pathname.split("/").at(-1)!
  const roots = [
    "app",
    "components",
    "lib",
    "worker",
    "workstation",
    "scripts",
    "tests",
    "db",
    "types",
    "deploy",
  ]
  for (const root of roots) {
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name)
      assert(!file.toLowerCase().includes(upstreamName), file)
      if (entry.isFile()) {
        const content = await readFile(file, "utf8")
        assert(!content.toLowerCase().includes(upstreamName), file)
      }
    }
  }
  for (const file of ["package.json", "package-lock.json"]) {
    const pack = JSON.parse(await readFile(file, "utf8"))
    assert.equal(pack.name, "owndesk")
    if (pack.packages) assert.equal(pack.packages[""].name, "owndesk")
  }
  const dockerfile = await readFile("workstation/Dockerfile", "utf8")
  assert(dockerfile.includes("USER agent\nWORKDIR /home/agent"))
  assert(dockerfile.includes('CMD ["owndesk-desktop"]'))
  for (const source of ["lib/workstation.ts", "workstation/controller/server.mjs"]) {
    assert((await readFile(source, "utf8")).includes("/home/agent"), source)
  }
  assert((await readFile("LICENSE", "utf8")).includes("2026 Sourav Bera"))
  for (const entry of provenance.files) {
    assert.equal(typeof entry.sourcePath, "string")
    if (entry.mode !== "excluded") await readFile(entry.path)
  }
})
