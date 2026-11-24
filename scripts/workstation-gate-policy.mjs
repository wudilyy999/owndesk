// Trusted B2 policy. Construct daemon requests from the installation's recipe;
// never send a candidate-supplied HostConfig, mounts or command through unchanged.
import { isDeepStrictEqual as same } from "node:util"
export function demand(ok, status = 403) {
  if (!ok)
    throw Object.assign(
      new Error(
        status === 404
          ? "No such container or volume"
          : "Workstation gate refused request"
      ),
      { status }
    )
}
const defaults = (v) =>
  v == null ||
  v === false ||
  v === 0 ||
  v === "" ||
  (typeof v === "object" && Object.values(v).every(defaults))
function allow(object, fields) {
  demand(object && typeof object === "object" && !Array.isArray(object))
  for (const [k, v] of Object.entries(object))
    if (!fields.includes(k)) demand(defaults(v))
}
export function gatePolicy(config) {
  const { install, owner, stack, image, ref, network, agents } = config
  demand(
    /^[a-f0-9-]{36}$/.test(install) &&
      /^[a-f0-9-]{36}$/.test(owner) &&
      /^sha256:[0-9a-f]{64}$/.test(image) &&
      typeof ref === "string" &&
      /^[a-zA-Z0-9_.-]{1,120}$/.test(network) &&
      /^[a-zA-Z0-9_.-]{1,90}$/.test(stack) &&
      Array.isArray(agents) &&
      agents.length > 0 &&
      agents.every((a) => /^[a-zA-Z0-9_-]{1,100}$/.test(a))
  )
  const objects = new Map()
  for (const agent of agents)
    for (const role of ["ws", "viewer", "home", "display"])
      objects.set(`pa-${install.slice(0, 8)}-${role}-${agent}`, { agent, role })
  function object(name, roles) {
    const o = objects.get(name)
    demand(o && roles.includes(o.role), 404)
    return o
  }
  function labels(agent) {
    return {
      "personal-agent.install": install,
      "personal-agent.agent": agent,
      "owndesk.lab": owner,
      "owndesk.lab.stack": stack,
    }
  }
  function owns(label, agent) {
    return Object.entries(labels(agent)).every(([k, v]) => label?.[k] === v)
  }
  function volume(name, b) {
    const { agent } = object(name, ["home", "display"])
    allow(b, ["Name", "Labels", "Driver"])
    demand(
      b.Name === name &&
        (!b.Driver || b.Driver === "local") &&
        same(b.Labels, {
          "personal-agent.install": install,
          "personal-agent.agent": agent,
        })
    )
    return { Name: name, Driver: "local", Labels: labels(agent) }
  }
  function create(name, b) {
    const { agent, role } = object(name, ["ws", "viewer"])
    const viewer = role === "viewer",
      prefix = `pa-${install.slice(0, 8)}`
    const display = `${prefix}-display-${agent}`,
      home = `${prefix}-home-${agent}`
    const binds = viewer
      ? [`${display}:/tmp/.X11-unix:ro`]
      : [`${home}:/home/agent`, `${display}:/tmp/.X11-unix`]
    const h = b.HostConfig
    allow(b, [
      "Image",
      "Env",
      "Labels",
      "HostConfig",
      "NetworkingConfig",
      "Hostname",
      "AttachStdout",
      "AttachStderr",
      "Cmd",
      "Entrypoint",
    ])
    demand(b.Image === ref || b.Image === image)
    const installLabels = {
      "personal-agent.install": install,
      "personal-agent.agent": agent,
      ...(viewer ? {} : { "personal-agent.protocol": "6" }),
    }
    demand(same(b.Labels, installLabels))
    demand(viewer ? !b.Hostname : b.Hostname === "workstation")
    const cmd = ["--", "/bin/bash", "/usr/local/bin/pa-viewer"]
    demand(
      viewer
        ? same(b.Entrypoint, ["/usr/bin/tini"]) && same(b.Cmd, cmd)
        : !b.Entrypoint && !b.Cmd
    )
    allow(h, [
      "Binds",
      "NetworkMode",
      "Dns",
      "CapDrop",
      "Sysctls",
      "NanoCpus",
      "Memory",
      "ShmSize",
      "RestartPolicy",
      "MemorySwappiness",
      "ReadonlyRootfs",
      "SecurityOpt",
      "Tmpfs",
    ])
    demand(h.MemorySwappiness == null || [-1, 0].includes(h.MemorySwappiness))
    demand(
      !h.RestartPolicy ||
        (["", "no"].includes(h.RestartPolicy.Name) && !h.RestartPolicy.MaximumRetryCount)
    )
    demand(
      Array.isArray(h.Binds) &&
        same([...h.Binds].sort(), [...binds].sort()) &&
        h.NetworkMode === (viewer ? "none" : network)
    )
    const cpu = viewer ? 500000000 : 1000000000,
      mem = (viewer ? 256 : 1024) * 1024 * 1024
    demand(h.NanoCpus === cpu && h.Memory === mem)
    const sys = {
      "net.ipv6.conf.all.disable_ipv6": "1",
      "net.ipv6.conf.default.disable_ipv6": "1",
    }
    if (viewer) {
      demand(
        h.ReadonlyRootfs &&
          same(h.CapDrop, ["ALL"]) &&
          same(h.SecurityOpt, ["no-new-privileges:true"]) &&
          same(h.Tmpfs, { "/tmp": "rw,nosuid,nodev,size=64m" }) &&
          defaults(h.Dns) &&
          defaults(h.Sysctls) &&
          !h.ShmSize
      )
    } else {
      demand(
        !h.ReadonlyRootfs &&
          same(h.CapDrop, ["CAP_NET_RAW"]) &&
          same(h.Dns, ["127.0.0.1"]) &&
          same(h.Sysctls, sys) &&
          h.ShmSize === 1073741824 &&
          defaults(h.SecurityOpt) &&
          defaults(h.Tmpfs)
      )
    }
    const endpoints = b.NetworkingConfig?.EndpointsConfig ?? {}
    demand(
      Object.entries(endpoints).every(([k, v]) => k === h.NetworkMode && defaults(v))
    )
    allow(b.NetworkingConfig ?? {}, ["EndpointsConfig"])
    const env = {}
    for (const line of b.Env ?? []) {
      demand(typeof line === "string" && line.length < 240)
      const i = line.indexOf("=")
      const k = line.slice(0, i),
        v = line.slice(i + 1)
      demand(i > 0 && !Object.hasOwn(env, k))
      const rule = {
        OWNDESK_VNC_PASSWORD: /^[a-zA-Z0-9+/=]{8}$/,
        ...(viewer
          ? { PYTHONDONTWRITEBYTECODE: /^1$/ }
          : {
              PA_WORKSPACE_TOKEN: /^[0-9a-f]{64}$/,
              OWNDESK_IDLE_MINUTES: /^0$/,
              LANG: /^[a-zA-Z0-9_.@-]{1,40}$/,
              LANGUAGE: /^[a-zA-Z0-9_.@-]{1,40}$/,
              TZ: /^[a-zA-Z0-9_+/-]{1,60}$/,
            }),
      }
      demand(Object.hasOwn(rule, k) && rule[k].test(v))
      env[k] = v
    }
    demand(
      env.OWNDESK_VNC_PASSWORD &&
        (viewer
          ? env.PYTHONDONTWRITEBYTECODE
          : env.PA_WORKSPACE_TOKEN && env.OWNDESK_IDLE_MINUTES === "0")
    )
    return {
      Image: image,
      User: "agent",
      Hostname: viewer ? "viewer" : "workstation",
      Labels: { ...labels(agent), ...installLabels },
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      ...(viewer ? { Entrypoint: ["/usr/bin/tini"], Cmd: cmd } : {}),
      HostConfig: {
        NetworkMode: viewer ? "none" : network,
        Binds: binds,
        Memory: mem,
        MemorySwap: mem,
        NanoCpus: cpu,
        PidsLimit: 512,
        CapDrop: viewer ? ["ALL"] : ["CAP_NET_RAW"],
        SecurityOpt: ["no-new-privileges:true"],
        ...(viewer
          ? { ReadonlyRootfs: true, Tmpfs: { "/tmp": "rw,nosuid,nodev,size=64m" } }
          : { ShmSize: 1073741824, Dns: ["127.0.0.1"], Sysctls: sys }),
      },
    }
  }
  return { volume, create, object, owns, labels }
}
