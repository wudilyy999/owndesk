import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

test("snapshot verification authenticates the full file set and config offline; damaged, mismatched and escaping inputs fail before Docker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pa-snapshot-"))
  const id = randomUUID()
  const master = randomBytes(32).toString("hex")
  const auth = randomBytes(32).toString("hex")
  const configText = `INSTALL_ID=${id}\nMASTER_KEY=${master}\nBETTER_AUTH_SECRET=${auth}\n`
  const keyFile = path.join(directory, "keys.env")
  const key = Buffer.from(
    hkdfSync("sha512", Buffer.from(master, "hex"), id, "personal-agent/snapshot/v1", 64)
  )
  const mac = (text: string | Buffer) =>
    createHmac("sha512", key).update(text).digest("hex")
  const files = {
    "database.dump": Buffer.from("unit receipt fixture, not a PostgreSQL dump"),
    "artifacts.tar.gz": Buffer.from("unit receipt fixture, not a tar archive"),
    "images.tar": Buffer.from("unit receipt fixture, not a Docker image archive"),
  }
  const body = {
    format: 2,
    snapshotId: randomUUID(),
    installId: id,
    configMac: mac(`config:${configText}`),
    images: Object.fromEntries(
      ["web", "worker", "postgres", "caddy", "workstation"].map((name) => [
        name,
        { id: name },
      ])
    ),
    volumes: [
      { name: `pa-${id}_artifacts`, file: "artifacts.tar.gz", kind: "artifacts" },
    ],
    files: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        {
          bytes: bytes.length,
          mac: createHmac("sha512", key)
            .update(`file:${name}\n`)
            .update(bytes)
            .digest("hex"),
        },
      ])
    ),
  }
  const manifest = (value: unknown) =>
    JSON.stringify({ ...(value as object), signature: mac(JSON.stringify(value)) })
  const original = manifest(body)
  const manifestFile = path.join(directory, "manifest.json")
  const run = () =>
    spawnSync(process.execPath, ["scripts/snapshot.mjs", "verify", keyFile, directory], {
      encoding: "utf8",
      env: { ...process.env, PATH: directory, DOCKER_HOST: "tcp://127.0.0.1:1" },
    })
  try {
    await writeFile(keyFile, configText, { mode: 0o600 })
    await writeFile(manifestFile, original)
    for (const [name, bytes] of Object.entries(files))
      await writeFile(path.join(directory, name), bytes)
    const valid = run()
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /Docker was not accessed/)
    assert(!valid.stdout.includes(master) && !valid.stdout.includes(auth))

    await writeFile(keyFile, configText.replace(master, randomBytes(32).toString("hex")))
    assert.match(run().stderr, /signature\/key mismatch/)
    await writeFile(keyFile, configText + "APP_URL=https://changed.example\n")
    assert.match(run().stderr, /matching unmodified/)
    await writeFile(keyFile, configText)

    await writeFile(path.join(directory, "database.dump"), "corrupt")
    assert.match(run().stderr, /Snapshot file damaged/)
    await rm(path.join(directory, "database.dump"))
    assert.match(run().stderr, /ENOENT/)
    await symlink(keyFile, path.join(directory, "database.dump"))
    assert.match(run().stderr, /regular files/)
    await rm(path.join(directory, "database.dump"))
    await writeFile(path.join(directory, "database.dump"), files["database.dump"])

    await writeFile(
      manifestFile,
      manifest({ ...body, volumes: [{ ...body.volumes[0], file: "../outside" }] })
    )
    assert.notEqual(run().status, 0)
    await writeFile(manifestFile, original.replace('"format":2', '"format":3'))
    assert.match(run().stderr, /signature\/key mismatch/)
    await writeFile(manifestFile, original)
    assert.equal(run().status, 0)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test("snapshot input errors keep private config values out of diagnostics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pa-snapshot-input-"))
  const secret = `invalid-private-key-${randomUUID()}`
  const configFile = path.join(directory, "keys.env")
  try {
    await writeFile(
      configFile,
      `INSTALL_ID=${randomUUID()}\nMASTER_KEY=${secret}\nBETTER_AUTH_SECRET=${secret}\n`
    )
    const result = spawnSync(
      process.execPath,
      ["scripts/snapshot.mjs", "verify", configFile, directory],
      { encoding: "utf8" }
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /original 32-byte hex master key/)
    assert(!result.stderr.includes(secret) && !result.stdout.includes(secret))
    assert.equal((await readFile(configFile, "utf8")).includes(secret), true)
  } finally {
    await rm(directory, { recursive: true })
  }
})
