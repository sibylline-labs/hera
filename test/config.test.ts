import { inspect } from "node:util";
import { Effect, Exit, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  HeraConfig,
  HeraConfigError,
  Keyring,
  stripTrailingNewline,
} from "../src/core/config/index.js";
import { KeyHash, OrgId } from "../src/core/schema/index.js";

describe("HeraConfig — 3-State Eris Secret Reader & Redacted<T> Envelopes", () => {
  describe("stripTrailingNewline", () => {
    it("strips a single trailing LF or CRLF without stripping leading or internal whitespace", () => {
      expect(stripTrailingNewline("secret\n")).toBe("secret");
      expect(stripTrailingNewline("secret\r\n")).toBe("secret");
      expect(stripTrailingNewline("  padded secret  \n")).toBe("  padded secret  ");
      expect(stripTrailingNewline("line1\nline2\r\n")).toBe("line1\nline2");
      expect(stripTrailingNewline("secret\n\n")).toBe("secret\n");
    });
  });

  describe("HeraConfig.secret", () => {
    const validOrgId = "org_01ARZ3NDEKTSV4RRFFQ69G5FAV";

    it("returns unconfigured when env or binding is missing, undefined, null, empty, or only a single trailing newline", () => {
      const reader = HeraConfig.secret("SIBYLLINE_ORG_ID", OrgId);

      for (const env of [
        undefined,
        null,
        {},
        { SIBYLLINE_ORG_ID: undefined },
        { SIBYLLINE_ORG_ID: null },
        { SIBYLLINE_ORG_ID: "" },
        { SIBYLLINE_ORG_ID: "\n" },
        { SIBYLLINE_ORG_ID: "\r\n" },
      ]) {
        const res = reader(env);
        expect(HeraConfig.isUnconfigured(res)).toBe(true);
        expect(res).toEqual({
          _tag: "Unconfigured",
          status: "unconfigured",
          envKey: "SIBYLLINE_ORG_ID",
        });
      }
    });

    it("strips a single trailing LF or CRLF on valid secrets and wraps in Redacted<T>", () => {
      for (const raw of [validOrgId, `${validOrgId}\n`, `${validOrgId}\r\n`]) {
        const res = HeraConfig.secret(
          { SIBYLLINE_ORG_ID: raw },
          "SIBYLLINE_ORG_ID",
          OrgId
        );
        expect(HeraConfig.isValid(res)).toBe(true);
        if (HeraConfig.isValid(res)) {
          expect(Redacted.isRedacted(res.value)).toBe(true);
          expect(String(res.value)).toBe("<redacted>");
          expect(JSON.stringify(res.value)).toBe('"<redacted>"');
          expect(JSON.stringify({ secret: res.value })).toBe(
            '{"secret":"<redacted>"}'
          );
          expect(inspect(res.value)).toBe("<redacted>");
          expect(String(res)).toBe("<redacted>");
          expect(Redacted.value(res.value)).toBe(validOrgId);
          expect(HeraConfig.unwrap(res.value)).toBe(validOrgId);
        }
      }
    });

    it("preserves intentional whitespace when schema allows, and marks whitespace-only strings as invalid (never unconfigured) when schema rejects", () => {
      const paddedPassphrase = "  correct horse battery staple  ";
      const allowedRes = HeraConfig.secret(
        { PASSPHRASE: `${paddedPassphrase}\n` },
        "PASSPHRASE",
        Schema.String
      );
      expect(HeraConfig.isValid(allowedRes)).toBe(true);
      if (HeraConfig.isValid(allowedRes)) {
        expect(HeraConfig.unwrap(allowedRes.value)).toBe(paddedPassphrase);
      }

      const rejectedRes = HeraConfig.secret(
        { SIBYLLINE_ORG_ID: "   \n" },
        "SIBYLLINE_ORG_ID",
        OrgId
      );
      expect(HeraConfig.isInvalid(rejectedRes)).toBe(true);
      expect(HeraConfig.isUnconfigured(rejectedRes)).toBe(false);
    });

    it("returns invalid without echoing the secret when validation fails or binding is non-string", () => {
      const leakedMaterial = "super-secret-invalid-org-token-99999";
      const res = HeraConfig.secret(
        { SIBYLLINE_ORG_ID: leakedMaterial },
        "SIBYLLINE_ORG_ID",
        OrgId
      );

      expect(HeraConfig.isInvalid(res)).toBe(true);
      if (HeraConfig.isInvalid(res)) {
        expect(res.envKey).toBe("SIBYLLINE_ORG_ID");
        expect(res.reason).not.toContain(leakedMaterial);
        expect(JSON.stringify(res.issues)).not.toContain(leakedMaterial);
        expect(JSON.stringify(res)).not.toContain(leakedMaterial);
        expect(res.issues.length).toBeGreaterThan(0);
      }

      const nonStringRes = HeraConfig.secret(
        { SIBYLLINE_ORG_ID: 12345 },
        "SIBYLLINE_ORG_ID",
        OrgId
      );
      expect(HeraConfig.isInvalid(nonStringRes)).toBe(true);
      if (HeraConfig.isInvalid(nonStringRes)) {
        expect(nonStringRes.issues[0]?.code).toBe("InvalidType");
        expect(nonStringRes.reason).not.toContain("12345");
      }
    });

    it("supports HeraConfig.match pattern matching and Effect.gen yield* with 503 *_unconfigured vs 503 *_invalid_config", () => {
      const reader = HeraConfig.secret("WEBHOOK_HASH", KeyHash);
      const validHash =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

      const matchOut = HeraConfig.match(
        reader({ WEBHOOK_HASH: `${validHash}\n` }),
        {
          onUnconfigured: () => "unconfigured",
          onInvalid: () => "invalid",
          onValid: (val) => `valid:${String(val)}:${HeraConfig.unwrap(val)}`,
        }
      );
      expect(matchOut).toBe(`valid:<redacted>:${validHash}`);

      const program = Effect.gen(function* () {
        const redactedHash = yield* reader;
        return HeraConfig.unwrap(redactedHash);
      });

      const ok = Effect.runSync(
        program.pipe(
          Effect.provide(HeraConfig.layer({ WEBHOOK_HASH: `${validHash}\r\n` }))
        )
      );
      expect(ok).toBe(validHash);

      const unconfExit = Effect.runSyncExit(
        program.pipe(Effect.provide(HeraConfig.layer({})))
      );
      expect(Exit.isFailure(unconfExit)).toBe(true);
      if (Exit.isFailure(unconfExit)) {
        const err = unconfExit.cause.reasons[0];
        expect(err?._tag).toBe("Fail");
        if (err?._tag === "Fail") {
          const configErr = err.error as HeraConfigError;
          expect(configErr).toBeInstanceOf(HeraConfigError);
          expect(configErr.status).toBe("unconfigured");
          expect(configErr.httpStatus).toBe(503);
          expect(configErr.errorCode).toBe("webhook_hash_unconfigured");
        }
      }

      const invalidSecret = "not-a-valid-sha256-hash-secret-value";
      const invalidExit = Effect.runSyncExit(
        program.pipe(
          Effect.provide(HeraConfig.layer({ WEBHOOK_HASH: invalidSecret }))
        )
      );
      expect(Exit.isFailure(invalidExit)).toBe(true);
      if (Exit.isFailure(invalidExit)) {
        const err = invalidExit.cause.reasons[0];
        if (err?._tag === "Fail") {
          const configErr = err.error as HeraConfigError;
          expect(configErr.status).toBe("invalid");
          expect(configErr.httpStatus).toBe(503);
          expect(configErr.errorCode).toBe("webhook_hash_invalid_config");
          expect(configErr.message).not.toContain(invalidSecret);
          expect(JSON.stringify(configErr)).not.toContain(invalidSecret);
        }
      }
    });
  });

  describe("HeraConfig.hexKey", () => {
    const key32Hex =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const key16Hex = "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf";

    it("decodes 32-byte (default) and 16-byte hex keys with trailing newlines into Redacted<Uint8Array>", () => {
      const reader32 = HeraConfig.hexKey("AES_MASTER_KEY");
      const res32 = reader32({ AES_MASTER_KEY: `${key32Hex.toUpperCase()}\r\n` });

      expect(HeraConfig.isValid(res32)).toBe(true);
      if (HeraConfig.isValid(res32)) {
        expect(String(res32.value)).toBe("<redacted>");
        expect(JSON.stringify(res32.value)).toBe('"<redacted>"');
        const bytes = HeraConfig.unwrap(res32.value);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.byteLength).toBe(32);
        expect(bytes[0]).toBe(0x00);
        expect(bytes[15]).toBe(0x0f);
        expect(bytes[31]).toBe(0x1f);
      }

      const res16 = HeraConfig.hexKey(
        { HMAC_KEY: `${key16Hex}\n` },
        "HMAC_KEY",
        16
      );
      expect(HeraConfig.isValid(res16)).toBe(true);
      if (HeraConfig.isValid(res16)) {
        const bytes = HeraConfig.unwrap(res16.value);
        expect(bytes.byteLength).toBe(16);
        expect(bytes[0]).toBe(0xa0);
        expect(bytes[15]).toBe(0xaf);
      }
    });

    it("returns unconfigured on empty/missing and invalid on wrong length or non-hex chars without leaking raw input", () => {
      expect(
        HeraConfig.isUnconfigured(HeraConfig.hexKey({}, "AES_MASTER_KEY"))
      ).toBe(true);
      expect(
        HeraConfig.isUnconfigured(
          HeraConfig.hexKey({ AES_MASTER_KEY: "\n" }, "AES_MASTER_KEY")
        )
      ).toBe(true);

      const badCandidates = [
        "deadbeef", // wrong length (4 bytes vs 32 bytes)
        "0011223", // odd length
        "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", // non-hex
      ];

      for (const candidate of badCandidates) {
        const res = HeraConfig.hexKey(
          { AES_MASTER_KEY: candidate },
          "AES_MASTER_KEY",
          32
        );
        expect(HeraConfig.isInvalid(res)).toBe(true);
        if (HeraConfig.isInvalid(res)) {
          expect(res.reason).not.toContain(candidate);
          expect(JSON.stringify(res)).not.toContain(candidate);
        }
      }
    });
  });

  describe("HeraConfig.keyring", () => {
    const v1Hex = "11".repeat(32);
    const v2Hex = "22".repeat(32);
    const v3Hex = "33".repeat(32);

    it("parses versioned comma-separated keyrings (v1:<hex>,v2:<hex>) into Redacted<Keyring> and selects highest version as active", () => {
      const raw = `v1:${v1Hex},v3:${v3Hex},v2:${v2Hex}\r\n`;
      const res = HeraConfig.keyring(
        { TOKEN_KEYRING: raw },
        "TOKEN_KEYRING",
        { byteLength: 32 }
      );

      expect(HeraConfig.isValid(res)).toBe(true);
      if (HeraConfig.isValid(res)) {
        expect(String(res.value)).toBe("<redacted>");
        expect(JSON.stringify(res.value)).toBe('"<redacted>"');
        expect(inspect(res.value)).toBe("<redacted>");

        const kr = HeraConfig.unwrap(res.value);
        expect(kr).toBeInstanceOf(Keyring);
        expect(kr.size).toBe(3);
        expect(kr.versions).toEqual(["v1", "v3", "v2"]);
        expect(kr.activeVersion).toBe("v3");
        expect(kr.currentVersion).toBe("v3");
        expect(kr.activeKey[0]).toBe(0x33);
        expect(kr.currentKey[0]).toBe(0x33);
        expect(kr.get("v1")?.[0]).toBe(0x11);
        expect(kr.get(1)?.[0]).toBe(0x11);
        expect(kr.get("2")?.[0]).toBe(0x22);
        expect(kr.get("v99")).toBeUndefined();
        expect(kr.has("v2")).toBe(true);
        expect(kr.has(3)).toBe(true);
        expect(kr.has("v99")).toBe(false);

        // Defense-in-depth: even the unwrapped Keyring instance redacts on string/JSON/inspect
        expect(String(kr)).toBe("<redacted>");
        expect(JSON.stringify(kr)).toBe('"<redacted>"');
        expect(inspect(kr)).toBe("<redacted>");
      }
    });

    it("rejects malformed entries, duplicate versions, empty segments, and inconsistent byte lengths without echoing the secret", () => {
      const reader = HeraConfig.keyring("TOKEN_KEYRING", 16);
      const valid16A = "aa".repeat(16);
      const valid16B = "bb".repeat(16);

      const invalidCases = [
        `v1:${valid16A},v1:${valid16B}`, // duplicate version
        `v0:${valid16A}`, // v0 is not allowed
        `k1:${valid16A}`, // wrong prefix
        `v1:${valid16A},`, // trailing empty segment
        `,v1:${valid16A}`, // leading empty segment
        `v1:${valid16A},,v2:${valid16B}`, // middle empty segment
        `v1:abc`, // odd length hex
        `v1:${"cc".repeat(32)}`, // 32 bytes when 16 bytes configured
      ];

      for (const raw of invalidCases) {
        const res = reader({ TOKEN_KEYRING: raw });
        expect(HeraConfig.isInvalid(res)).toBe(true);
        if (HeraConfig.isInvalid(res)) {
          expect(res.reason).not.toContain(valid16A);
          expect(res.reason).not.toContain(raw);
          expect(JSON.stringify(res)).not.toContain(valid16A);
        }
      }

      // Mismatched lengths across entries when byteLength is inferred
      const mismatchedRes = HeraConfig.keyring(
        { TOKEN_KEYRING: `v1:${"aa".repeat(16)},v2:${"bb".repeat(32)}` },
        "TOKEN_KEYRING"
      );
      expect(HeraConfig.isInvalid(mismatchedRes)).toBe(true);
    });
  });
});
