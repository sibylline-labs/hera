import { client } from "./client.js"
import { HeraOAuth2Error } from "./errors.js"

export type {
  HeraOAuth2Client,
  HeraOAuth2ClientConfig,
  HeraOAuth2TokenHint,
} from "./client.js"
export * from "./errors.js"
export type { HeraOAuth2TokenPair } from "./token-pair.js"

/**
 * OAuth 2.0 client namespace (`HeraOAuth2.client`).
 */
export const HeraOAuth2 = {
  client,
  HeraOAuth2Error,
} as const
