import { stripe } from "./stripe.js"
import { refusalReason, verifyHmac } from "./verify-hmac.js"

export {
  type HeraWebhookAlgo,
  type HeraWebhookEncoding,
  type HeraWebhookOptions,
  HeraWebhookRefusal,
  type HeraWebhookRefusalReason,
  type HeraWebhookSecret,
  type HeraWebhookSignatureHeader,
  type HeraWebhookTimestampOption,
} from "./types.js"
export { type HeraWebhookStripeOptions } from "./stripe.js"

/**
 * Signed-webhook verification (`HeraWebhook.verifyHmac`): constant-time HMAC over the raw body
 * against any key of a secret set, optional timestamp tolerance, one fixed `401` for every refusal.
 * `stripe` is the Stripe preset (`Stripe-Signature: t=…,v1=…`) built on it.
 */
export const HeraWebhook = {
  verifyHmac,
  stripe,
  refusalReason,
} as const
