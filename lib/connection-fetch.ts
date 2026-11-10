import { lookup as dnsLookup } from "node:dns/promises"
import type { LookupFunction } from "node:net"
import { Agent } from "undici"
import { HttpError } from "./errors"
import {
  connectionEndpointAllowed,
  loopbackEndpoint,
  publicAddress,
} from "./connection-endpoint"

type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>
const resolve: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

// Resolve once at connection time and give that exact checked set to the socket.
// A preflight lookup alone would leave a DNS-rebinding window.
export function connectionLookup(
  allowLoopback = false,
  resolver: Resolver = resolve
): LookupFunction {
  return (hostname, options, callback) => {
    void resolver(hostname).then(
      (addresses) => {
        const local = allowLoopback && loopbackEndpoint(hostname)
        if (
          !addresses.length ||
          addresses.some(({ address }) =>
            local ? !["127.0.0.1", "::1"].includes(address) : !publicAddress(address)
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
const publicAgent = new Agent({ connect: { lookup: connectionLookup() } })
const loopbackAgent = new Agent({ connect: { lookup: connectionLookup(true) } })

export function connectionFetch(allowLoopback = false): typeof fetch {
  return async (input, init) => {
    const value = input instanceof Request ? input.url : String(input)
    if (!connectionEndpointAllowed(value, allowLoopback))
      throw new HttpError(400, "Use a public HTTPS connection endpoint")
    const timeout = AbortSignal.timeout(30000),
      signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const options: RequestInit & { dispatcher: Agent } = {
      ...init,
      dispatcher: allowLoopback ? loopbackAgent : publicAgent,
      redirect: "error", // Never follow redirects, including OAuth/metadata redirects.
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }
    return fetch(input, options)
  }
}
