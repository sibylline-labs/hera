import * as fc from "fast-check";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { HeraConfig } from "../src/core/config/index.js";
import { OrgId } from "../src/core/schema/index.js";

const newlineSuffixArb = fc.constantFrom("", "\n", "\r\n");

function bytesToHex(bytes: Uint8Array, upperCaseMask: boolean): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    const h = bytes[i]!.toString(16).padStart(2, "0");
    out += upperCaseMask && i % 2 === 0 ? h.toUpperCase() : h;
  }
  return out;
}

describe("HeraConfig — Property Tests", () => {
  it("strips at most one trailing LF/CRLF on arbitrary non-empty secrets and never leaks in Redacted serialization", () => {
    const baseSecretArb = fc
      .string({ minLength: 10, maxLength: 96 })
      .filter(
        (s) =>
          !s.endsWith("\n") &&
          !s.endsWith("\r") &&
          !s.includes("redacted") &&
          !s.includes("API_SECRET") &&
          !s.includes("Valid")
      );

    fc.assert(
      fc.property(baseSecretArb, newlineSuffixArb, (baseSecret, suffix) => {
        const res = HeraConfig.secret(
          { API_SECRET: `${baseSecret}${suffix}` },
          "API_SECRET",
          Schema.String
        );

        expect(res.status).toBe("valid");
        if (res.status === "valid") {
          expect(HeraConfig.unwrap(res.value)).toBe(baseSecret);
          expect(String(res.value)).toBe("<redacted>");
          expect(JSON.stringify(res.value)).toBe('"<redacted>"');
          expect(JSON.stringify(res)).not.toContain(baseSecret);
        }
      }),
      { numRuns: 200 }
    );
  });

  it("round-trips arbitrary 16-byte and 32-byte keys through HeraConfig.hexKey with Redacted<Uint8Array>", () => {
    const byteLengthArb = fc.constantFrom(16, 32);

    fc.assert(
      fc.property(
        byteLengthArb,
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.boolean(),
        newlineSuffixArb,
        (byteLength, rawBytes, upperMask, suffix) => {
          const slice = rawBytes.subarray(0, byteLength);
          const hex = bytesToHex(slice, upperMask);
          const res = HeraConfig.hexKey(
            { MASTER_KEY: `${hex}${suffix}` },
            "MASTER_KEY",
            byteLength
          );

          expect(res.status).toBe("valid");
          if (res.status === "valid") {
            expect(String(res.value)).toBe("<redacted>");
            expect(JSON.stringify(res.value)).toBe('"<redacted>"');
            const decoded = HeraConfig.unwrap(res.value);
            expect(Array.from(decoded)).toEqual(Array.from(slice));
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it("round-trips arbitrary multi-version keyrings and selects the highest version as activeKey", () => {
    const entrySpecArb = fc.uniqueArray(
      fc.record({
        versionNumber: fc.integer({ min: 1, max: 50 }),
        bytes: fc.uint8Array({ minLength: 16, maxLength: 16 }),
      }),
      {
        minLength: 1,
        maxLength: 5,
        selector: (item) => item.versionNumber,
      }
    );

    fc.assert(
      fc.property(entrySpecArb, newlineSuffixArb, (specs, suffix) => {
        const serialized =
          specs
            .map(
              (s) => `v${s.versionNumber}:${bytesToHex(s.bytes, false)}`
            )
            .join(",") + suffix;

        const res = HeraConfig.keyring(
          { SIGNING_KEYRING: serialized },
          "SIGNING_KEYRING",
          16
        );

        expect(res.status).toBe("valid");
        if (res.status === "valid") {
          expect(String(res.value)).toBe("<redacted>");
          expect(JSON.stringify(res.value)).toBe('"<redacted>"');

          const kr = HeraConfig.unwrap(res.value);
          expect(String(kr)).toBe("<redacted>");
          expect(JSON.stringify(kr)).toBe('"<redacted>"');
          expect(kr.size).toBe(specs.length);

          let maxSpec = specs[0]!;
          for (const spec of specs) {
            if (spec.versionNumber > maxSpec.versionNumber) {
              maxSpec = spec;
            }
            const retrieved = kr.get(spec.versionNumber);
            expect(retrieved).toBeDefined();
            expect(Array.from(retrieved!)).toEqual(Array.from(spec.bytes));
          }

          expect(kr.activeVersion).toBe(`v${maxSpec.versionNumber}`);
          expect(Array.from(kr.activeKey)).toEqual(Array.from(maxSpec.bytes));
        }
      }),
      { numRuns: 200 }
    );
  });

  it("never echoes rejected secret material in InvalidSecret reason or issues across secret, hexKey, and keyring", () => {
    const invalidCandidateArb = fc
      .string({ minLength: 12, maxLength: 60 })
      .filter(
        (s) =>
          s.replace(/\r?\n$/, "").length >= 12 &&
          !/^(?:org_)?[0-9A-HJKMNP-TV-Z]{26}$/.test(s.replace(/\r?\n$/, "")) &&
          !/^[0-9a-fA-F]{64}$/.test(s.replace(/\r?\n$/, "")) &&
          !s.includes("ORG_SECRET") &&
          !s.includes("HEX_SECRET") &&
          !s.includes("RING_SECRET") &&
          !s.includes("invalid")
      );

    fc.assert(
      fc.property(invalidCandidateArb, (badValue) => {
        const normalized = badValue.replace(/\r?\n$/, "");

        const secretRes = HeraConfig.secret(
          { ORG_SECRET: badValue },
          "ORG_SECRET",
          OrgId
        );
        expect(secretRes.status).toBe("invalid");
        if (secretRes.status === "invalid") {
          expect(secretRes.reason).not.toContain(normalized);
          expect(JSON.stringify(secretRes.issues)).not.toContain(normalized);
          expect(JSON.stringify(secretRes)).not.toContain(normalized);
        }

        const hexRes = HeraConfig.hexKey(
          { HEX_SECRET: badValue },
          "HEX_SECRET",
          32
        );
        expect(hexRes.status).toBe("invalid");
        if (hexRes.status === "invalid") {
          expect(hexRes.reason).not.toContain(normalized);
          expect(JSON.stringify(hexRes.issues)).not.toContain(normalized);
          expect(JSON.stringify(hexRes)).not.toContain(normalized);
        }

        const ringRes = HeraConfig.keyring(
          { RING_SECRET: badValue },
          "RING_SECRET",
          32
        );
        expect(ringRes.status).toBe("invalid");
        if (ringRes.status === "invalid") {
          expect(ringRes.reason).not.toContain(normalized);
          expect(JSON.stringify(ringRes.issues)).not.toContain(normalized);
          expect(JSON.stringify(ringRes)).not.toContain(normalized);
        }
      }),
      { numRuns: 200 }
    );
  });
});
