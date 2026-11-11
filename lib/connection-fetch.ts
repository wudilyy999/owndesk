import { lookup as dnsLookup } from "node:dns/promises"
import { isIP, type LookupFunction } from "node:net"
import { Agent } from "undici"
import { HttpError } from "./errors"
import {
  connectionEndpointAllowed,
  fakeIpAddress,
  loopbackEndpoint,
  publicAddress,
} from "./connection-endpoint"

type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>
const resolve: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

// Resolve once at connection time and give that exact checked set to the socket.
// A preflight lookup alone would leave a DNS-rebinding window.
export function connectionLookup(
  allowLoopback = false,
  resolver: Resolver = resolve,
  allowFakeIp = false
): LookupFunction {
  return (hostname, options, callback) => {
    void resolver(hostname).then(
      (addresses) => {
        const local = allowLoopback && loopbackEndpoint(hostname)
        const fakeIp =
          allowFakeIp &&
          !isIP(hostname) &&
          connectionEndpointAllowed(`https://${hostname}`)
        if (
          !addresses.length ||
          addresses.some(({ address }) =>
            local
              ? !["127.0.0.1", "::1"].includes(address)
              : !(publicAddress(address) || (fakeIp && fakeIpAddress(address)))
          )
        ) {
          callback(
            new HttpError(400, "Connection endpoint resolves to a non-public address"),
            "",
            0
          )
          return
        }
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0].address, addresses[0].family)
      },
      (error: Error) => callback(error, "", 0)
    )
  }
}
// Isolate pools by trust policy; a relaxed connection is never reused by strict fetch.
const agents = new Map<string, Agent>()
function connectionAgent(allowLoopback: boolean, allowFakeIp: boolean) {
  const key = `${allowLoopback}:${allowFakeIp}`
  let agent = agents.get(key)
  if (!agent) {
    agent = new Agent({
      connect: { lookup: connectionLookup(allowLoopback, resolve, allowFakeIp) },
    })
    agents.set(key, agent)
  }
  return agent
}

export function connectionFetch(
  allowLoopback = false,
  allowFakeIp = process.env.MCP_ALLOW_FAKE_IP === "true"
): typeof fetch {
  return async (input, init) => {
    const value = input instanceof Request ? input.url : String(input)
    if (!connectionEndpointAllowed(value, allowLoopback))
      throw new HttpError(400, "Use a public HTTPS connection endpoint")
    const timeout = AbortSignal.timeout(30000),
      signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const options: RequestInit & { dispatcher: Agent } = {
      ...init,
      dispatcher: connectionAgent(allowLoopback, allowFakeIp),
      redirect: "error", // Never follow redirects, including OAuth/metadata redirects.
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }
    return fetch(input, options)
  }
}
