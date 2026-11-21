/**
 * Config reader primitives & schema binding.
 */

export {
  TRAILING_LINE_ENDING,
  isInvalid,
  isUnconfigured,
  isValid,
  layer,
  match,
  stripTrailingNewline,
  unwrap,
} from "./env-reader.js";
export { hexKey } from "./hex-key.js";
export { Keyring, keyring } from "./keyring.js";
export { secret } from "./secret.js";
