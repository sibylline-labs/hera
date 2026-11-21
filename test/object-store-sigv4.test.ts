import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import { signSigV4 } from "../src/core/object-store/sigv4"
import { AWS_EXAMPLE_KEY } from "./fixtures/provider-tokens.js"

// AWS's published S3 example ("GET Object", Signature Calculations for the Authorization Header:
// Transferring Payload in a Single Chunk). Example keys from AWS docs; not real credentials.
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

describe("signSigV4", () => {
  // admits: a wrong canonical request or key derivation signs every R2 request wrongly; crypto output is runtime data no type sees
  it("matches AWS's S3 GetObject example signature", async () => {
    const headers = await signSigV4({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { range: "bytes=0-9" },
      payloadSha256: EMPTY_SHA256,
      credentials: {
        accessKeyId: Redacted.make(AWS_EXAMPLE_KEY),
        secretAccessKey: Redacted.make("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
      },
      region: "us-east-1",
      service: "s3",
      nowMs: Date.UTC(2013, 4, 24),
    })
    expect(headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${AWS_EXAMPLE_KEY}/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`
    )
    expect(headers["x-amz-date"]).toBe("20130524T000000Z")
  })
})
