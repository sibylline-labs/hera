/**
 * Credential shapes from gitleaks' default rule set (MIT), by rule id. Pass
 * {@link GITLEAKS_SHAPES} as `secretShapes` and every run matching one is replaced in place,
 * wherever it sits in a string. The patterns drop gitleaks' keyword and entropy gates, so they flag
 * a bare token; each head is fixed, so a lookalike (`ghp_short`, a 40-hex git SHA) stays readable.
 */
export interface GitleaksRule {
  readonly id: string
  readonly shape: RegExp
}

export const GITLEAKS_RULES: ReadonlyArray<GitleaksRule> = [
  { id: "github-pat", shape: /ghp_[0-9a-zA-Z]{36}/g },
  { id: "github-oauth", shape: /gho_[0-9a-zA-Z]{36}/g },
  { id: "github-app-token", shape: /(?:ghu|ghs)_[0-9a-zA-Z]{36}/g },
  { id: "github-refresh-token", shape: /ghr_[0-9a-zA-Z]{36}/g },
  { id: "github-fine-grained-pat", shape: /github_pat_\w{82}/g },
  { id: "aws-access-token", shape: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g },
  { id: "gcp-api-key", shape: /\bAIza[\w-]{35}/g },
  { id: "anthropic-api-key", shape: /sk-ant-(?:api03|admin01)-[\w-]{93}AA/g },
  { id: "openai-api-key", shape: /sk-(?:(?:proj|svcacct|admin)-)?[A-Za-z0-9_-]{20,74}T3BlbkFJ[A-Za-z0-9_-]{20,74}/g },
  { id: "slack-bot-token", shape: /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/g },
  { id: "slack-user-token", shape: /xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}/g },
  { id: "slack-app-token", shape: /xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+/gi },
  { id: "stripe-access-token", shape: /\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}/g },
  { id: "gitlab-pat", shape: /glpat-[\w-]{20}/g },
  { id: "npm-access-token", shape: /\bnpm_[a-z0-9]{36}\b/gi },
  { id: "sendgrid-api-token", shape: /\bSG\.[A-Za-z0-9=_.-]{66}/g },
  { id: "huggingface-access-token", shape: /\bhf_[a-zA-Z]{34}\b/g },
  { id: "jwt", shape: /\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_-]{17,}\.(?:[a-zA-Z0-9/\\_-]{10,}={0,2})?/g },
  {
    id: "private-key",
    shape: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]*?KEY(?: BLOCK)?-----/g,
  },
]

export const GITLEAKS_SHAPES: ReadonlyArray<RegExp> = GITLEAKS_RULES.map((rule) => rule.shape)
