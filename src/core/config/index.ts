/**
 * 3-state Eris secret & config readers (`HeraConfig`).
 */

import {
  TRAILING_LINE_ENDING,
  isInvalid,
  isUnconfigured,
  isValid,
  layer,
  match,
  stripTrailingNewline,
  unwrap,
} from "./env-reader.js";
import { hexKey } from "./hex-key.js";
import { Keyring, keyring } from "./keyring.js";
import { managedVariables } from "./managed-variables.js";
import { secret } from "./secret.js";
import { HeraConfigError, HeraEnv } from "./types.js";

export * from "./types.js";
export * from "./env-reader.js";
export * from "./secret.js";
export * from "./hex-key.js";
export * from "./keyring.js";
export * from "./primitives.js";
export * from "./managed-variables.js";

/**
 * `HeraConfig` namespace: 3-state secret, hex-key and keyring readers.
 */
export const HeraConfig = {
  TRAILING_LINE_ENDING,
  stripTrailingNewline,
  HeraEnv,
  HeraConfigError,
  Keyring,
  secret,
  managedVariables,
  hexKey,
  keyring,
  isUnconfigured,
  isInvalid,
  isValid,
  unwrap,
  match,
  layer,
} as const;
