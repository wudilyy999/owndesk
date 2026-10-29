import assert from "node:assert/strict"
import test from "node:test"
import { directoryTreeSchema } from "@/db/schema"
import { verifyDirectoryTree } from "@/lib/artifact-checks"

const contract = { root: "/home/agent/Demo", directories: ["Ready"], absent: ["Draft"] }
test("fixed directory checker validates host-owned listings, missing names and ordinary types", () => {
  assert.equal(
    verifyDirectoryTree(["Demo/", "Demo/Ready/"], ["d", "d"], contract).grade,
    "program_checked"
  )
  assert.throws(() => verifyDirectoryTree(["Demo/"], ["d"], contract), /missing/)
  assert.throws(
    () =>
      verifyDirectoryTree(
        ["Demo/", "Demo/Ready/", "Demo/Draft/"],
        ["d", "d", "d"],
        contract
      ),
    /must be absent/
  )
  for (const type of ["l", "h", "p"])
    assert.throws(
      () => verifyDirectoryTree(["Demo/", "Demo/Ready/"], ["d", type], contract),
      /ordinary files/
    )
  assert.throws(
    () => verifyDirectoryTree(["Demo/", "Demo/../Ready/"], ["d", "d"], contract),
    /ordinary files/
  )
  assert.throws(
    () => verifyDirectoryTree(["Other/", "Other/Ready/"], ["d", "d"], contract),
    /ordinary files/
  )
})
test("owner directory contracts keep all paths inside the workstation home", () => {
  assert(directoryTreeSchema.safeParse(contract).success)
  for (const root of ["/home/agent", "/home/agent/../etc", "/etc", "/home/agent//Demo"])
    assert(!directoryTreeSchema.safeParse({ ...contract, root }).success)
  for (const name of ["../Ready", "/Ready", "a/../../Ready", "a\0b", "a\nb"])
    assert(!directoryTreeSchema.safeParse({ ...contract, directories: [name] }).success)
})
