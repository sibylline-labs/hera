/** One secret-shaped fixture per gitleaks rule id, assembled at run time so no literal secret sits in source. */
const rep = (chars: string, n: number) => chars.repeat(Math.ceil(n / chars.length)).slice(0, n)
const alnum = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xYz"
const lower = "abcdefghijklmnopqrstuvwxyz0123456789"
const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGH"
// Built from parts at run time so the source holds no secret-shaped literal.
export const GITLEAKS_FIXTURES: Record<string, string> = {
  "github-pat": "ghp" + "_" + rep(alnum, 36),
  "github-oauth": "gho" + "_" + rep(alnum, 36),
  "github-app-token": "ghs" + "_" + rep(alnum, 36),
  "github-refresh-token": "ghr" + "_" + rep(alnum, 36),
  "github-fine-grained-pat": "github" + "_pat_" + rep(alnum, 82),
  "aws-access-token": "AKIA" + rep(upper, 16),
  "gcp-api-key": "AIza" + rep(alnum, 35),
  "anthropic-api-key": "sk-ant-" + "api03-" + rep(alnum, 93) + "AA",
  "openai-api-key": "sk-" + "proj-" + rep(alnum, 58) + "T3Blbk" + "FJ" + rep(alnum, 58),
  "slack-bot-token": "xoxb" + "-1234567890-1234567890123-" + rep(alnum, 24),
  "slack-user-token": "xoxp" + "-1234567890-1234567890-1234567890-" + rep(lower, 30),
  "slack-app-token": "xapp" + "-1-A0123456789-1234567890-" + rep(lower, 20),
  "stripe-access-token": "sk" + "_live_" + rep(alnum, 24),
  "gitlab-pat": "glpat" + "-" + rep(alnum, 20),
  "npm-access-token": "npm" + "_" + rep(lower, 36),
  "sendgrid-api-token": "SG" + "." + rep(alnum, 66),
  "huggingface-access-token": "hf" + "_" + rep(alpha, 34),
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI" + "." + rep(alnum, 43),
  "private-key": "-----BEGIN RSA PRIVATE" + " KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE" + " KEY-----",
}
