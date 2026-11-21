import { credentialsFromApiToken } from "./credentials.js"
import { DEFAULT_OBJECT_MAX_BYTES, r2S3 } from "./r2-s3.js"

export type { HeraR2TokenCredentialsOptions } from "./credentials.js"
export { checkCustomMetadata, checkObjectKey } from "./metadata.js"
export type { HeraR2S3Config } from "./r2-s3.js"
export type { HeraS3Credentials } from "./sigv4.js"
export type * from "./types.js"

/**
 * Object store with etags, conditional writes and custom metadata: `r2S3` is R2 over
 * its S3-compatible endpoint; `HeraTest.objectStore()` is the in-memory fake for tests.
 */
export const HeraObjectStore = {
  r2S3,
  credentialsFromApiToken,
  DEFAULT_OBJECT_MAX_BYTES,
} as const
