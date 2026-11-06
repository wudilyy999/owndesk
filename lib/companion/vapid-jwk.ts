// Convert OwnDesk VAPID key pair (uncompressed P-256 point + scalar, both base64url —
// same shape as `web-push generate-vapid-keys` and scripts/vapid-keys.mjs) into a JWK
// that @pushforge/builder (MIT) accepts for RFC 8292 signing.
export function vapidToPrivateJwk(publicKey: string, privateKey: string): JsonWebKey {
  const point = Buffer.from(publicKey, "base64url")
  if (point.length !== 65 || point[0] !== 4) {
    throw new Error("VAPID public key must be an uncompressed P-256 point")
  }
  const d = Buffer.from(privateKey, "base64url")
  if (d.length !== 32) throw new Error("VAPID private key must be 32 bytes")
  return {
    kty: "EC",
    crv: "P-256",
    x: point.subarray(1, 33).toString("base64url"),
    y: point.subarray(33, 65).toString("base64url"),
    d: privateKey,
  }
}
