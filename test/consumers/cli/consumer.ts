export * as cli from "@sibylline-labs/hera/cli"
export * as core from "@sibylline-labs/hera/core"
export * as tui from "@sibylline-labs/hera/tui"
export * as objectStore from "@sibylline-labs/hera/object-store"
export * as cliErrors from "@sibylline-labs/hera/cli/errors"
export * as cliManifest from "@sibylline-labs/hera/cli/manifest"
export * as cliFs from "@sibylline-labs/hera/cli/fs"
export * as cliProcess from "@sibylline-labs/hera/cli/process"
export * as cliRuntime from "@sibylline-labs/hera/cli/runtime"

import type { RedactionClass } from "@sibylline-labs/hera/cli/errors"

// A missing or extra key fails tsc: RedactionClass is exactly eris outbound-scan's 13 classes.
export const redactionClasses: Record<RedactionClass, true> = {
  pem: true,
  jwt: true,
  "sib-token": true,
  "sibdc-code": true,
  "aws-key": true,
  "github-token": true,
  "slack-token": true,
  "google-api-key": true,
  "sk-key": true,
  "auth-header": true,
  "gcp-private-key": true,
  "conn-string": true,
  assignment: true,
}
