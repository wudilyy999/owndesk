import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHmac, hkdfSync, randomUUID } from "node:crypto"
import {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"

const [mode, configArgument, directoryArgument, separateArgument] = process.argv.slice(2)
assert(
  ["backup", "verify", "restore"].includes(mode) &&
    configArgument &&
    directoryArgument &&
    (mode !== "backup" || separateArgument),
  "Use snapshot.mjs backup CONFIG DATA_DIR SEPARATE_KEYS_FILE | verify KEYS_FILE DATA_DIR | restore KEYS_FILE DATA_DIR NEW_CONFIG"
)
const configFile = path.resolve(configArgument)
const directory = path.resolve(directoryArgument)
const separateFile = separateArgument && path.resolve(separateArgument)
assert(lstatSync(configFile).isFile(), "Configuration must be a regular file")
const configText = readFileSync(configFile, "utf8")
const config = parseEnv(configText)
assert(
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    config.INSTALL_ID ?? ""
  ),
  "Provide the installation UUID"
)
assert(
  /^[a-f0-9]{64}$/.test(config.MASTER_KEY ?? ""),
  "Provide the original 32-byte hex master key"
)
assert(config.BETTER_AUTH_SECRET?.length >= 32)
const project = `pa-${config.INSTALL_ID}`
const prefix = `pa-${config.INSTALL_ID.slice(0, 8)}`
const key = Buffer.from(
  hkdfSync(
    "sha512",
    Buffer.from(config.MASTER_KEY, "hex"),
    config.INSTALL_ID,
    "personal-agent/snapshot/v1",
    64
  )
)
const environment = { ...process.env, ...config }
const composeFile = fileURLToPath(new URL("../deploy/compose.yaml", import.meta.url))
const compose = [
  "compose",
  "--file",
  composeFile,
  "--env-file",
  configFile,
  "--project-name",
  project,
]

function docker(args, io) {
  const descriptor = io && openSync(io.file, io.input ? "r" : "wx", 0o600)
  try {
    return (
      execFileSync("docker", args, {
        env: environment,
        stdio: [
          io?.input ? descriptor : "ignore",
          io && !io.input ? descriptor : "pipe",
          "pipe",
        ],
        maxBuffer: 16 * 1024 * 1024,
      })
        ?.toString()
        .trim() ?? ""
    )
  } catch (error) {
    // Do not serialize the child process/options: environment contains deployment secrets.
    throw new Error(
      `Docker ${args[0]} failed: ${error.stderr?.toString().trim() || error.message}`
    )
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
function list(kind, filter) {
  return docker([
    kind,
    ...(kind === "ps" ? ["-a"] : ["ls"]),
    "--filter",
    filter,
    "--format",
    kind === "ps" ? "{{.ID}}" : "{{.Name}}",
  ])
    .split("\n")
    .filter(Boolean)
}
function inspect(args) {
  return JSON.parse(docker(["inspect", ...args]))
}
function mac(text) {
  return createHmac("sha512", key).update(text).digest("hex")
}
async function fileReceipt(file) {
  const stat = lstatSync(file)
  assert(stat.isFile(), "Snapshot members must be regular files")
  const digest = createHmac("sha512", key).update(`file:${path.basename(file)}\n`)
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return { bytes: stat.size, mac: digest.digest("hex") }
}
function sql(postgres, statement) {
  return docker([
    "exec",
    postgres,
    "psql",
    "-X",
    "--set",
    "ON_ERROR_STOP=1",
    "-U",
    "agent",
    "-d",
    "personal_agent",
    "-At",
    "-c",
    statement,
  ])
}
function archiveArgs(image, volume, restore) {
  return [
    "run",
    "--rm",
    ...(restore ? ["-i"] : []),
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "FOWNER",
    "--security-opt",
    "no-new-privileges:true",
    "--mount",
    `type=volume,src=${volume},dst=/volume${restore ? "" : ",readonly"}`,
    "--entrypoint",
    "tar",
    image,
    restore ? "--extract" : "--create",
    "--gzip",
    "--file",
    "-",
    "--directory",
    "/volume",
    "--numeric-owner",
    ...(restore ? ["--same-owner"] : ["."]),
  ]
}

if (mode === "backup") {
  assert(!existsSync(directory), "Use a new backup directory; preserve existing backups")
  assert(!existsSync(separateFile), "Use a new separate key file; preserve existing keys")
  const relativeKey = path.relative(directory, separateFile)
  assert(
    relativeKey === ".." ||
      relativeKey.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeKey),
    "Keep the key file outside the data backup directory"
  )
  const ids = list("ps", `label=com.docker.compose.project=${project}`)
  assert(ids.length, "This deployment has no Compose containers")
  const containers = inspect(ids)
  const services = Object.fromEntries(
    ["postgres", "web", "worker", "caddy"].map((service) => {
      const matches = containers.filter(
        (c) =>
          c.Config.Labels["com.docker.compose.service"] === service &&
          c.Config.Labels["com.docker.compose.oneoff"] === "False"
      )
      assert.equal(
        matches.length,
        1,
        `Expected one ${service} container; create the deployment before backup`
      )
      return [service, matches[0]]
    })
  )
  assert(services.postgres.State.Running, "Keep PostgreSQL running for the logical dump")
  assert(
    containers.every((c) => c.Id === services.postgres.Id || !c.State.Running),
    "Stop Caddy, Web, worker and one-off writers before backup"
  )
  assert(
    !docker([
      "ps",
      "--filter",
      `label=personal-agent.install=${config.INSTALL_ID}`,
      "--format",
      "{{.ID}}",
    ]),
    "Stop all installation workstations/viewers before backup"
  )
  assert.equal(
    Number(
      sql(
        services.postgres.Id,
        "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'"
      )
    ),
    0,
    "Close database clients before taking a consistent snapshot"
  )
  const database = JSON.parse(
    sql(
      services.postgres.Id,
      `SELECT json_build_object(
    'postgresMajor',current_setting('server_version_num')::integer/10000,
    'businessMigrations',(SELECT count(*) FROM drizzle.__drizzle_migrations),
    'workspaces',COALESCE((SELECT json_agg(agent_id) FROM workstation_control),'[]'::json),
    'activeTasks',COALESCE((SELECT json_agg(json_build_object('id',id,'status',status)) FROM tasks WHERE status NOT IN ('completed','cancelled','failed')),'[]'::json),
    'enabledRoutines',(SELECT count(*) FROM routines WHERE enabled AND deleted_at IS NULL),
    'artifactCount',(SELECT count(*) FROM artifacts))`
    )
  )
  assert.equal(database.postgresMajor, 16)
  const imageArgs = ["web", "worker", "postgres", "caddy"].map((name) => [
    name,
    services[name].Image,
  ])
  const workstationReference = services.worker.Config.Env.find((entry) =>
    entry.startsWith("WORKSTATION_IMAGE=")
  )?.slice(18)
  assert(workstationReference, "Worker workstation image is missing")
  imageArgs.push([
    "workstation",
    JSON.parse(docker(["image", "inspect", workstationReference]))[0].Id,
  ])
  const images = Object.fromEntries(
    imageArgs.map(([name, id]) => {
      const image = JSON.parse(docker(["image", "inspect", id]))[0]
      return [name, { id, os: image.Os, architecture: image.Architecture }]
    })
  )
  const runtime = JSON.parse(
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--entrypoint",
      "node",
      images.worker.id,
      "-e",
      `const fs=require('node:fs');const source=fs.readFileSync('lib/durable.ts','utf8');const p=JSON.parse(fs.readFileSync('package.json','utf8'));const journal=JSON.parse(fs.readFileSync('db/migrations/meta/_journal.json','utf8'));console.log(JSON.stringify({applicationVersion:source.match(/APPLICATION_VERSION = "([^"]+)"/)[1],migrations:journal.entries.map(e=>e.tag),dependencies:p.dependencies}));`,
    ])
  )
  assert.equal(
    database.businessMigrations,
    runtime.migrations.length,
    "Database and image migration versions differ"
  )
  const artifacts = services.worker.Mounts.find(
    (mount) => mount.Destination === "/app/data/artifacts"
  )
  assert.equal(artifacts?.Type, "volume")
  assert.equal(artifacts.Name, `${project}_artifacts`)
  const volumes = [{ name: artifacts.Name, file: "artifacts.tar.gz", kind: "artifacts" }]
  const homeIds = list("volume", `label=personal-agent.install=${config.INSTALL_ID}`)
  if (homeIds.length)
    for (const volume of JSON.parse(docker(["volume", "inspect", ...homeIds]))) {
      const agentId = volume.Labels["personal-agent.agent"]
      if (!volume.Name.startsWith(`${prefix}-home-`)) continue
      assert.match(agentId ?? "", /^[A-Za-z0-9_-]{1,100}$/)
      assert.equal(volume.Name, `${prefix}-home-${agentId}`)
      volumes.push({
        name: volume.Name,
        agentId,
        file: `home-${agentId}.tar.gz`,
        kind: "home",
      })
    }
  for (const agentId of database.workspaces)
    assert(
      volumes.some((volume) => volume.agentId === agentId),
      `Workstation home is missing: ${agentId}`
    )
  const guests = list("ps", `label=personal-agent.install=${config.INSTALL_ID}`)
  if (guests.length)
    assert(
      inspect(guests).every((c) => c.Image === images.workstation.id),
      "Drain/match workstation images before backup"
    )
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(separateFile, configText, { flag: "wx", mode: 0o600 })
  docker(
    [
      "exec",
      services.postgres.Id,
      "pg_dump",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "-U",
      "agent",
      "-d",
      "personal_agent",
    ],
    { file: path.join(directory, "database.dump") }
  )
  const files = {
    "database.dump": await fileReceipt(path.join(directory, "database.dump")),
  }
  docker(["image", "save", ...new Set(Object.values(images).map((image) => image.id))], {
    file: path.join(directory, "images.tar"),
  })
  files["images.tar"] = await fileReceipt(path.join(directory, "images.tar"))
  for (const volume of volumes) {
    const file = path.join(directory, volume.file)
    docker(archiveArgs(images.worker.id, volume.name, false), { file })
    files[volume.file] = await fileReceipt(file)
  }
  const body = {
    format: 2,
    snapshotId: randomUUID(),
    createdAt: new Date().toISOString(),
    installId: config.INSTALL_ID,
    configMac: mac(`config:${configText}`),
    ...runtime,
    database,
    images,
    volumes,
    files,
  }
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({ ...body, signature: mac(JSON.stringify(body)) }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 }
  )
  console.log(
    "Consistent snapshot complete. Data and separate keys are private; application/workstations remain stopped."
  )
} else {
  assert(
    lstatSync(path.join(directory, "manifest.json")).isFile(),
    "Manifest must be a regular file"
  )
  const { signature, ...body } = JSON.parse(
    readFileSync(path.join(directory, "manifest.json"), "utf8")
  )
  assert.equal(
    signature,
    mac(JSON.stringify(body)),
    "Snapshot signature/key mismatch; target was not modified"
  )
  assert.equal(body.format, 2, "Use a complete format-2 snapshot including pinned images")
  assert.equal(body.installId, config.INSTALL_ID)
  assert.equal(
    body.configMac,
    mac(`config:${configText}`),
    "Use the matching unmodified separate key/config file"
  )
  assert.deepEqual(Object.keys(body.images).sort(), [
    "caddy",
    "postgres",
    "web",
    "worker",
    "workstation",
  ])
  assert.deepEqual(
    Object.keys(body.files).sort(),
    ["database.dump", "images.tar", ...body.volumes.map((v) => v.file)].sort()
  )
  assert.equal(body.volumes.filter((v) => v.kind === "artifacts").length, 1)
  for (const volume of body.volumes) {
    if (volume.kind === "artifacts") {
      assert.equal(volume.name, `${project}_artifacts`)
      assert.equal(volume.file, "artifacts.tar.gz")
    } else {
      assert.equal(volume.kind, "home")
      assert.match(volume.agentId ?? "", /^[A-Za-z0-9_-]{1,100}$/)
      assert.equal(volume.name, `${prefix}-home-${volume.agentId}`)
      assert.equal(volume.file, `home-${volume.agentId}.tar.gz`)
    }
  }
  for (const [file, receipt] of Object.entries(body.files)) {
    assert.equal(file, path.basename(file))
    assert.deepEqual(
      await fileReceipt(path.join(directory, file)),
      receipt,
      `Snapshot file damaged: ${file}; target was not modified`
    )
  }
  if (mode === "verify") {
    console.log(
      "Snapshot signature, matching keys, complete file set and all streamed file receipts verified. Docker was not accessed."
    )
  } else {
    assert(
      separateFile &&
        !existsSync(separateFile) &&
        !existsSync(`${separateFile}.restore.json`),
      "Restore requires a new configuration output path"
    )
    assert.equal(
      list("ps", `label=com.docker.compose.project=${project}`).length,
      0,
      "Restore requires an empty target: Compose containers already exist"
    )
    assert.equal(
      list("ps", `label=personal-agent.install=${config.INSTALL_ID}`).length,
      0,
      "Restore requires an empty target: workstations already exist"
    )
    const presentVolumes = docker(["volume", "ls", "--format", "{{.Name}}"]).split("\n")
    for (const name of [
      `${project}_postgres`,
      `${project}_caddy`,
      `${project}_caddy_config`,
      ...body.volumes.map((v) => v.name),
    ])
      assert(!presentVolumes.includes(name), `Restore refuses existing volume: ${name}`)
    const platform = docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"])
    for (const image of Object.values(body.images))
      assert.equal(
        `${image.os}/${image.architecture}`,
        platform,
        "Restore requires the snapshot's tested OS/architecture"
      )
    docker(["image", "load"], { file: path.join(directory, "images.tar"), input: true })
    for (const image of Object.values(body.images)) {
      const actual = JSON.parse(docker(["image", "inspect", image.id]))[0]
      assert.equal(actual.Os, image.os)
      assert.equal(actual.Architecture, image.architecture)
    }
    const pins = Object.fromEntries(
      Object.entries(body.images).map(([name, image]) => [
        `PA_${name.toUpperCase()}_IMAGE`,
        image.id,
      ])
    )
    Object.assign(environment, pins)
    // Record the exact restored images. Operators may edit the address only after recovery checks.
    writeFileSync(
      separateFile,
      configText +
        "\n" +
        Object.entries(pins)
          .map(([name, id]) => `${name}=${id}`)
          .join("\n") +
        "\n",
      { flag: "wx", mode: 0o600 }
    )
    docker([...compose, "up", "-d", "--no-build", "--wait", "postgres"])
    const postgres = docker([...compose, "ps", "-q", "postgres"])
    docker(
      [
        "exec",
        "-i",
        postgres,
        "pg_restore",
        "--exit-on-error",
        "--single-transaction",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "-U",
        "agent",
        "-d",
        "personal_agent",
      ],
      { file: path.join(directory, "database.dump"), input: true }
    )
    for (const volume of body.volumes) {
      docker([
        "volume",
        "create",
        "--label",
        ...(volume.kind === "home"
          ? [
              `personal-agent.install=${config.INSTALL_ID}`,
              "--label",
              `personal-agent.agent=${volume.agentId}`,
            ]
          : [
              `com.docker.compose.project=${project}`,
              "--label",
              "com.docker.compose.volume=artifacts",
            ]),
        volume.name,
      ])
      docker(archiveArgs(body.images.worker.id, volume.name, true), {
        file: path.join(directory, volume.file),
        input: true,
      })
    }
    const restoreId = randomUUID()
    sql(
      postgres,
      `BEGIN;
      DELETE FROM desktop_tickets;
      DELETE FROM "session";
      UPDATE workstation_control SET epoch=epoch+1,boot_id=NULL,updated_at=now();
      UPDATE routines SET enabled=false,next_run_at=NULL,plan_version=plan_version+1 WHERE enabled AND deleted_at IS NULL;
      UPDATE telegram_connection SET generation='${restoreId}',user_id=NULL,chat_id=NULL,owner_name=NULL,paired_at=NULL,thread_id=NULL,task_id=NULL,pair_code=NULL,pair_expires_at=NULL,last_poll_at=NULL,last_error='Restored snapshot: pair again after reconciliation';
      WITH changed AS (UPDATE tasks SET next_event_seq=next_event_seq+1,updated_at=now() RETURNING id,next_event_seq)
      INSERT INTO task_events(task_id,seq,key,type,payload,created_at) SELECT id,next_event_seq,'restore:${restoreId}','snapshot_restored',json_build_object('snapshotId','${body.snapshotId}','message','Snapshot restored. Review later external effects; old control grants and sessions are invalid. Routines paused and Telegram unpaired.'),now() FROM changed;
      COMMIT;`
    )
    writeFileSync(
      `${separateFile}.restore.json`,
      JSON.stringify(
        {
          snapshotId: body.snapshotId,
          restoreId,
          restoredAt: new Date().toISOString(),
          applicationVersion: body.applicationVersion,
          activeTasks: body.database.activeTasks,
          routinesPaused: true,
          telegramUnpaired: true,
          oldSessionsAndTicketsRevoked: true,
          workstationEpochAdvanced: true,
          applicationStarted: false,
          tlsStateRegenerated: true,
        },
        null,
        2
      ) + "\n",
      { flag: "wx", mode: 0o600 }
    )
    console.log(
      "Restore complete; only PostgreSQL is running. Check network, artifacts, credentials and unresolved/later external effects before explicitly starting Web/worker. Routines are paused; Telegram requires pairing; HTTPS needs a fresh CA/certificate."
    )
  }
}
