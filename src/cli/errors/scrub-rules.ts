/**
 * The 13 credential redaction classes and the ordered rule table `scrubFreeText` applies.
 *
 * Classes, shapes and pass order follow eris's outbound scan (`packages/outbound-scan/src/redact.ts`).
 * Two properties hold over and above eris's shapes:
 *
 * - Monotonic on the shapes Hera's earlier table redacted: token runs are unbounded where the earlier
 *   shapes were, a fixed-length token also takes a padded tail, and a credential that merely starts
 *   with an earlier class's marker is still redacted whole.
 * - Linear: every rule is a single character-class run, a bounded alternation, or an atomic
 *   (lookahead + backreference) run; none nests an unbounded quantifier inside another.
 * - Exact-marker guards: a pass that takes an arbitrary run as its value (`auth-header`,
 *   `conn-string`, `gcp-private-key`, `assignment`) declines that run only when it is exactly one
 *   marker and nothing more, so it never re-redacts its own output and never ships a tail glued to
 *   a marker.
 *
 * Order is load-bearing, most specific first:
 *
 * 1. `gcp-private-key` before `pem`: a JSON-embedded GCP key is also a PEM block.
 * 2. `sib-token` and `sibdc-code` right after `jwt`: their base64url secret can contain `sk-` or
 *    `ghp_`, and a later class taking only that run would leave the token head in plaintext.
 * 3. `aws-key`'s key-id pass runs twice, after `sibdc-code` and again after `conn-string`: the id
 *    is `\b`-anchored, so an id glued to a later class's match finds its boundary only once that
 *    class's marker is in place.
 * 4. `auth-header` before `assignment`: `Authorization: Bearer …` also matches `NAME: value`.
 *
 * `scrubFreeText` runs the table once, as eris does: no rule matches another's output except where
 * the order above hands it over in the same pass, so a second scrub never changes the text.
 */

/** Every redaction class, in eris's fixed order. */
export const REDACTION_CLASSES = [
  "pem",
  "jwt",
  "sib-token",
  "sibdc-code",
  "aws-key",
  "github-token",
  "slack-token",
  "google-api-key",
  "sk-key",
  "auth-header",
  "gcp-private-key",
  "conn-string",
  "assignment",
] as const;

export type RedactionClass = (typeof REDACTION_CLASSES)[number];

export interface ScrubRule {
  readonly cls: RedactionClass;
  readonly regex: RegExp;
  readonly replace: string | ((...args: string[]) => string);
}

/** Regex source for exactly one marker. */
const MARKER = "<redacted:[a-z-]{1,40}>";
const EXACT_MARKER = new RegExp(`^${MARKER}$`);
/** A value run that is exactly one marker: the marker, then no further value character. */
const IS_MARKER_VALUE = `${MARKER}(?![^\\s"',;])`;
/**
 * A header name where a credential would be: the credential belongs to that later header. `x-api-key`
 * counts only with a colon, which no base64 credential holds.
 */
const NEXT_HEADER = "(?:Authorization\\s*[:=]|(?:x-)?api-key\\s*:)";
const KNOWN_AUTH_SCHEMES = "(?:Bearer|Basic|Token|Digest|Negotiate|NTLM|OAuth|DPoP)";

const SECRET_KEYWORD_GROUP =
  "(?:secret|token|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|session[_-]?key|signing[_-]?key|webhook[_-]?secret|encryption[_-]?key|master[_-]?key|credentials?)";

/**
 * A governed NAME followed by whitespace and then its operator (`aws_secret_access_key =`), standing
 * where a bare Bearer credential would be. Bounded runs keep it linear, and the whitespace before
 * the operator is what no token, base64 value or `host:port` contains.
 */
const SPACED_NAME = `[A-Za-z0-9_.-]{0,60}${SECRET_KEYWORD_GROUP}[A-Za-z0-9_.-]{0,60}\\s+[:=]`;

/**
 * Token characters glued after a fixed-length token (a padded token): the whole run is absorbed,
 * unless it is followed by an operator, when it is a NAME the assignment pass needs
 * (`<token>PASSWORD=…`). The lookahead + backreference takes the run atomically, so this is linear.
 */
const PADDED_TAIL = "(?:(?=([A-Za-z0-9_-]+))\\1(?!\\s*[:=]))?";

const AWS_KEY_ID: ScrubRule = {
  cls: "aws-key",
  regex: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g,
  replace: "<redacted:aws-key>",
};

const PRESERVED_VALUES = new Set(["true", "false", "null", "undefined", "none"]);

function assignmentReplace(
  full: string,
  prefix: string,
  dq1: string,
  dqVal: string,
  dq2: string,
  sq1: string,
  sqVal: string,
  sq2: string,
  bareVal: string,
): string {
  const val = dqVal ?? sqVal ?? bareVal ?? "";
  if (EXACT_MARKER.test(val) || PRESERVED_VALUES.has(val)) {
    return full;
  }
  if (dq1) return `${prefix}${dq1}<redacted:assignment>${dq2}`;
  if (sq1) return `${prefix}${sq1}<redacted:assignment>${sq2}`;
  return `${prefix}<redacted:assignment>`;
}

export const SCRUB_RULES: ReadonlyArray<ScrubRule> = [
  // Any non-empty JSON "private_key" string value, PEM or not. The closing quote must end the
  // string (not open a glued next key or marker), so a second scrub never finds a quote this one
  // consumed.
  {
    cls: "gcp-private-key",
    regex: new RegExp(`("private_key"\\s*:\\s*")(?!${MARKER}")(?:[^"\\\\]|\\\\.)+(")(?![A-Za-z0-9_<])`, "g"),
    replace: "$1<redacted:gcp-private-key>$2",
  },
  {
    cls: "pem",
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: "<redacted:pem>",
  },
  {
    cls: "jwt",
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replace: "<redacted:jwt>",
  },
  // sib_<26-char ULID>_<43 base64url>, plus a padded tail.
  {
    cls: "sib-token",
    regex: new RegExp(`sib_[0-9A-Za-z]{26}_[A-Za-z0-9_-]{43}${PADDED_TAIL}`, "g"),
    replace: "<redacted:sib-token>",
  },
  // sibdc_<8-letter user code>_<43 base64url>: a device code redeems a fresh sib_ bearer.
  {
    cls: "sibdc-code",
    regex: new RegExp(`sibdc_[A-Za-z]{8}_[A-Za-z0-9_-]{43}${PADDED_TAIL}`, "g"),
    replace: "<redacted:sibdc-code>",
  },
  AWS_KEY_ID,
  // eris's AWS secret shape, only where the value ends cleanly; a longer or non-base64 value (and
  // a NAME glued after it) is left whole for the assignment pass, which redacts all of it.
  {
    cls: "aws-key",
    regex: /(aws_secret_access_key\s*[:=]\s*['"]?)[A-Za-z0-9/+=]{20,80}(?![^\s"',;])/gi,
    replace: "$1<redacted:aws-key>",
  },
  {
    cls: "github-token",
    regex: /(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replace: "<redacted:github-token>",
  },
  {
    cls: "slack-token",
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    replace: "<redacted:slack-token>",
  },
  {
    cls: "google-api-key",
    regex: new RegExp(`AIza[0-9A-Za-z_-]{35}${PADDED_TAIL}`, "g"),
    replace: "<redacted:google-api-key>",
  },
  // sk-*, sk-ant-*, sk-proj-*, ol_live_*, lin_api_*, other *_live_/*_test_ keys, and a sib_ token
  // whose secret is shorter than the issued 43 characters.
  {
    cls: "sk-key",
    regex:
      /\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}|(?:ol|sib|sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}|sib_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]+|lin_api_[A-Za-z0-9_-]{12,})\b/g,
    replace: "<redacted:sk-key>",
  },
  // Authorization with a known scheme: the scheme stays visible, the credential goes.
  {
    cls: "auth-header",
    regex: new RegExp(
      `(Authorization\\s*[:=]\\s*${KNOWN_AUTH_SCHEMES}\\s+)(?!${IS_MARKER_VALUE}|${NEXT_HEADER}|${KNOWN_AUTH_SCHEMES}\\s)[^\\s"',;]+`,
      "gi",
    ),
    replace: "$1<redacted:auth-header>",
  },
  // Authorization with any other RFC 7235 scheme (or a raw key and no scheme): all of it goes.
  {
    cls: "auth-header",
    regex: new RegExp(
      `(Authorization\\s*[:=]\\s*)(?!${KNOWN_AUTH_SCHEMES}\\s|${NEXT_HEADER})[A-Za-z][A-Za-z0-9._-]{0,40}\\s+(?!${NEXT_HEADER})[^\\s"',;]+`,
      "gi",
    ),
    replace: "$1<redacted:auth-header>",
  },
  {
    cls: "auth-header",
    regex: new RegExp(`(Bearer\\s+)(?!${SPACED_NAME})[A-Za-z0-9._~+/=-]{16,}`, "gi"),
    replace: "$1<redacted:auth-header>",
  },
  {
    cls: "auth-header",
    regex: new RegExp(`((?:x-api-key|api-key)\\s*[:=]\\s*)(?!${IS_MARKER_VALUE})[^\\s"',;]+`, "gi"),
    replace: "$1<redacted:auth-header>",
  },
  // Known schemes keep scheme, user and host for triage; only the password goes.
  {
    cls: "conn-string",
    regex: new RegExp(
      `\\b((?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis(?:s)?|amqp(?:s)?):\\/\\/[^:\\s/@"']+:)(?!${MARKER}@)([^@\\s"']+)(@[^\\s"']+)`,
      "gi",
    ),
    replace: "$1<redacted:conn-string>$3",
  },
  // Any other scheme (eris's shape, unbounded runs): the whole span goes, since an unanchored scheme
  // run can carry text glued before it and a host run can carry a key glued after it. Quotes end
  // every run, as in the known-scheme shape, so a JSON string's closing quote is never swallowed.
  {
    cls: "conn-string",
    regex: new RegExp(
      `[a-zA-Z][a-zA-Z0-9+.-]{0,30}:\\/\\/[^\\s:@/"']+:(?!${MARKER}@)[^\\s@/"']+@[^\\s/"']+`,
      "g",
    ),
    replace: "<redacted:conn-string>",
  },
  AWS_KEY_ID,
  {
    cls: "assignment",
    regex: new RegExp(
      `(\\b[A-Za-z0-9_.-]{0,60}${SECRET_KEYWORD_GROUP}[A-Za-z0-9_.-]{0,60}["']?\\s*[:=]\\s*)(?!${IS_MARKER_VALUE})(?:(")([^"\\n]{4,})(")|(')([^'\\n]{4,})(')|([^\\s"',;\\n]{4,}))`,
      "gi",
    ),
    replace: assignmentReplace,
  },
  // Standalone 64-hex private keys (0x-prefixed or raw).
  {
    cls: "assignment",
    regex: /\b(?:0x)?[0-9a-fA-F]{64}\b/g,
    replace: "<redacted:assignment>",
  },
];
