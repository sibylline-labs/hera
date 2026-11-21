/**
 * Provider-shaped credentials for redaction tests, joined at run time so no source line holds a
 * whole token. A literal that matches a provider's token pattern trips secret scanners (gitleaks,
 * GitHub push protection) wherever it sits in the tree.
 */
const join = (...parts: string[]) => parts.join("")

export const GITHUB_TOKEN = join("gh", "p_", "1234567890abcdefghijklmnopqrstuvwxyzABCD")
export const GITHUB_TOKEN_A = join("gh", "p_", "A".repeat(36))
export const SLACK_BOT_TOKEN = join("xo", "xb-", "123456789012-1234567890123-abcdefghijklmnopqrstuvwx")
export const SLACK_BOT_TOKEN_SHORT = join("xo", "xb-", "1234567890-abcdef")
export const LINEAR_TOKEN = join("lin_a", "pi_", "0123456789abcdef", "0123456789abcdef01234567")
export const GOOGLE_API_KEY = join("AI", "zaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe")
export const ANTHROPIC_KEY = join("sk", "-ant-", "api03-abcdefghijklmnopqrstuvwxyz0123456789")
export const AWS_EXAMPLE_KEY = join("AK", "IAIOSFODNN7EXAMPLE")
export const JWT_IO = join(
  "ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
  "ey", "JzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.",
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
)
export const JWT_HS256 = join(
  "ey", "JhbGciOiJIUzI1NiJ9.",
  "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0.",
  "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
)
export const GCP_KEY_BODY = join("MIIEvQIBADANBgkq", "hkiG9w0BAQEFAASC")
export const PEM_BEGIN_PRIVATE = join("-----BEGIN ", "PRIVATE KEY-----")
export const PEM_END_PRIVATE = join("-----END ", "PRIVATE KEY-----")
export const PEM_BEGIN_RSA = join("-----BEGIN RSA ", "PRIVATE KEY-----")
export const PEM_END_RSA = join("-----END RSA ", "PRIVATE KEY-----")
