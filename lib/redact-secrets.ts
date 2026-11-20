const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g,
]

export function redactSecrets(text: string) {
  return SECRET_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, "[已隐去的密钥]"),
    text
  )
}
