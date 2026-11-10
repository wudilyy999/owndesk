import ipaddr from "ipaddr.js"

export function publicAddress(address: string) {
  try {
    // Mapped/transition IPv6 ranges are not public unicast either.
    return ipaddr.parse(address).range() === "unicast"
  } catch {
    return false
  }
}
// RFC 2544 is not public. Only an explicitly trusted fake-IP proxy may use
// these DNS answers; literal URLs and all other reserved ranges stay blocked.
export function fakeIpAddress(address: string) {
  try {
    const ip = ipaddr.parse(address)
    return ip.kind() === "ipv4" && ip.match(ipaddr.parse("198.18.0.0"), 15)
  } catch {
    return false
  }
}
export function loopbackEndpoint(hostname: string) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
}
export function connectionEndpointAllowed(value: string, allowLoopback = false) {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return false
    if (allowLoopback && loopbackEndpoint(url.hostname))
      return ["http:", "https:"].includes(url.protocol)
    if (url.protocol !== "https:") return false
    const host = url.hostname.replace(/^\[|\]$/g, "")
    if (ipaddr.isValid(host)) return publicAddress(host)
    return !/^(localhost|.*\.localhost|.*\.local|.*\.internal)\.?$/i.test(host)
  } catch {
    return false
  }
}
