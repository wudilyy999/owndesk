// Generates a VAPID key pair (RFC 8292, P-256) the same way `web-push generate-vapid-keys` does:
// public = uncompressed point, private = scalar, both base64url. Used by deploy-env.mjs and push-keys.mjs.
import { generateKeyPairSync } from "node:crypto"

export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const jwk = privateKey.export({ format: "jwk" })
  const x = Buffer.from(jwk.x, "base64url")
  const y = Buffer.from(jwk.y, "base64url")
  return {
    publicKey: Buffer.concat([Buffer.from([4]), x, y]).toString("base64url"),
    privateKey: jwk.d,
  }
}
