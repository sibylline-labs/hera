import { inspect } from "node:util";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  HeraConfig,
  Keyring,
  type KeyringLegacyOptions,
  type SecretStatus,
} from "../src/core/config/index.js";
import { decodeStandardBase64 } from "../src/core/config/keyring-legacy.js";

// Fixture key material only: bytes 0x00..0x1f, never a real secret.
const FIXTURE_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i);
const FIXTURE_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const FIXTURE_HEX = Array.from(FIXTURE_BYTES, (b) => b.toString(16).padStart(2, "0")).join("");

const KEYRING = "TOKEN_KEYRING";
const LEGACY = "TOKEN_KEK";
const legacy: KeyringLegacyOptions = { key: LEGACY, encoding: "base64", version: "v1" };
const options = { byteLength: 32, legacy } as const;

function fixtureBytes(byteLength: number): Uint8Array {
  return Uint8Array.from({ length: byteLength }, (_, i) => i & 0x1f);
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function expectNoMaterial(status: SecretStatus<Keyring>, raw: string): void {
  const rendered = `${JSON.stringify(status)} ${String(status)}`;
  expect(rendered).not.toContain(raw.replace(/\r?\n$/, ""));
  expect(rendered).not.toContain(FIXTURE_B64);
  expect(rendered).not.toContain(FIXTURE_HEX);
}

function unwrapValid(status: SecretStatus<Keyring>): Keyring {
  expect(status.status).toBe("valid");
  if (!HeraConfig.isValid(status)) throw new Error("expected a valid keyring");
  return HeraConfig.unwrap(status.value);
}

describe("HeraConfig.keyring legacy fallback", () => {
  // admits: a service on the old single key failing on deploy (every lease unreadable); env contents are runtime.
  it("loads only the legacy key as a one-entry keyring at its version, active and redacted", () => {
    for (const raw of [FIXTURE_B64, `${FIXTURE_B64}\n`, `${FIXTURE_B64}\r\n`]) {
      const status = HeraConfig.keyring({ [LEGACY]: raw }, KEYRING, options);
      const kr = unwrapValid(status);
      expect(status.envKey).toBe(LEGACY);
      expect(kr.versions).toEqual(["v1"]);
      expect(kr.activeVersion).toBe("v1");
      expect(kr.activeKey).toEqual(FIXTURE_BYTES);
      expect(kr.get("v1")).toEqual(FIXTURE_BYTES);
      expect(String(kr)).toBe("<redacted>");
      expect(inspect(kr)).toBe("<redacted>");
      expectNoMaterial(status, raw);
    }

    const v3 = HeraConfig.keyring({ [LEGACY]: FIXTURE_B64 }, KEYRING, {
      byteLength: 32,
      legacy: { ...legacy, version: "v3" },
    });
    expect(unwrapValid(v3).activeVersion).toBe("v3");
  });

  // admits: the legacy key shadowing or merging into a set keyring; precedence is a runtime branch.
  it("uses only the keyring's entries when both are set", () => {
    const raw = `v1:${"11".repeat(32)},v2:${"12".repeat(32)}`;
    const status = HeraConfig.keyring({ [KEYRING]: raw, [LEGACY]: FIXTURE_B64 }, KEYRING, options);
    const kr = unwrapValid(status);
    expect(status.envKey).toBe(KEYRING);
    expect(kr.versions).toEqual(["v1", "v2"]);
    expect(kr.get("v1")?.[0]).toBe(0x11);
    expect(kr.activeKey[0]).toBe(0x12);
  });

  // admits: a typo in the new keyring silently running on the old key; a runtime branch on env contents.
  it("never falls back when the keyring is set but malformed", () => {
    const status = HeraConfig.keyring(
      { [KEYRING]: "v1:not-hex", [LEGACY]: FIXTURE_B64 },
      KEYRING,
      options,
    );
    expect(status.status).toBe("invalid");
    expect(status.envKey).toBe(KEYRING);
    expectNoMaterial(status, "v1:not-hex");
  });

  // admits: both slots unset read as Invalid or Valid, breaking 503 *_unconfigured; runtime.
  it("is Unconfigured on the keyring key when both are unset", () => {
    for (const env of [undefined, {}, { [KEYRING]: "", [LEGACY]: "\n" }]) {
      const status = HeraConfig.keyring(env, KEYRING, options);
      expect(status.status).toBe("unconfigured");
      expect(status.envKey).toBe(KEYRING);
    }
  });

  // admits: a malformed key accepted, or key material echoed in a reason; value-level, no type sees it.
  it("rejects a malformed legacy value as Invalid on the legacy key without echoing it", () => {
    const cases: ReadonlyArray<unknown> = [
      toBase64(fixtureBytes(31)), // 31 bytes
      toBase64(fixtureBytes(33)), // 33 bytes
      FIXTURE_B64.slice(0, -1), // unpadded
      `${FIXTURE_B64}=`, // extra pad
      `${FIXTURE_B64.slice(0, -2)}A==`, // wrong pad count
      `${FIXTURE_B64.slice(0, -1)}-`, // non-alphabet char in the pad slot (atob would throw)
      FIXTURE_B64.replace("AAEC", "-_EC"), // base64url alphabet
      ` ${FIXTURE_B64.slice(1)}`, // leading space
      `${FIXTURE_B64.slice(0, 20)}\n${FIXTURE_B64.slice(21)}`, // internal newline
      `${FIXTURE_B64}\n\n`, // two trailing newlines
      FIXTURE_HEX, // hex, not base64
      42, // not a string
    ];
    for (const raw of cases) {
      const status = HeraConfig.keyring({ [LEGACY]: raw }, KEYRING, options);
      expect(status.status, String(raw)).toBe("invalid");
      expect(status.envKey).toBe(LEGACY);
      if (HeraConfig.isInvalid(status)) {
        expect(status.reason).toContain("standard base64 of a 32-byte key");
      }
      expectNoMaterial(status, String(raw));
    }
  });

  // admits: a pad-count or length off-by-one refusing a valid key for some byteLength; arithmetic on values.
  it("accepts standard base64 of exactly byteLength bytes for every padding case", () => {
    for (let byteLength = 1; byteLength <= 48; byteLength++) {
      const bytes = fixtureBytes(byteLength);
      const status = HeraConfig.keyring({ [LEGACY]: toBase64(bytes) }, KEYRING, {
        byteLength,
        legacy,
      });
      expect(unwrapValid(status).activeKey).toEqual(bytes);
      expect(decodeStandardBase64(toBase64(bytes), byteLength + 1)).toBeUndefined();
    }
  });

  // admits: a bad version/encoding/key option loading anyway; untyped callers bypass the union type.
  it("rejects a malformed legacy option as Invalid on the keyring key before reading env", () => {
    const env = { [LEGACY]: FIXTURE_B64 };
    const bad: ReadonlyArray<unknown> = [
      { byteLength: 32, legacy: { ...legacy, version: "1" } },
      { byteLength: 32, legacy: { ...legacy, version: "v0" } },
      { byteLength: 32, legacy: { ...legacy, version: "v01" } },
      { byteLength: 32, legacy: { ...legacy, encoding: "hex" } },
      { byteLength: 32, legacy: { ...legacy, key: "" } },
      { byteLength: 32, legacy: { ...legacy, key: KEYRING } },
      { legacy },
    ];
    for (const opts of bad) {
      const status = HeraConfig.keyring(env, KEYRING, opts as Parameters<typeof HeraConfig.keyring>[2]);
      expect(status.status).toBe("invalid");
      expect(status.envKey).toBe(KEYRING);
      expectNoMaterial(status, FIXTURE_B64);
    }

    // @ts-expect-error a legacy fallback needs byteLength
    HeraConfig.keyring(env, KEYRING, { legacy });
  });

  // admits: the reader reading a legacy key it was not given (default behaviour drifting); runtime.
  it("keeps the default behaviour without legacy: a legacy-looking key is never read", () => {
    const env = { [LEGACY]: FIXTURE_B64 };
    expect(HeraConfig.keyring(env, KEYRING).status).toBe("unconfigured");
    expect(HeraConfig.keyring(env, KEYRING, 32).status).toBe("unconfigured");
    expect(HeraConfig.keyring(env, KEYRING, { byteLength: 32 }).status).toBe("unconfigured");
    expect(HeraConfig.keyring(KEYRING, { byteLength: 32 })(env).status).toBe("unconfigured");

    // Untyped callers: a null options or legacy reads as absent, never throws.
    const untyped = HeraConfig.keyring as (e: unknown, k: string, o: unknown) => SecretStatus<Keyring>;
    expect(untyped(env, KEYRING, null).status).toBe("unconfigured");
    expect(untyped(env, KEYRING, { byteLength: 32, legacy: null }).status).toBe("unconfigured");
    expect(untyped({ [KEYRING]: `v1:${FIXTURE_HEX}` }, KEYRING, null).status).toBe("valid");
  });

  // admits: the reader / Effect forms dropping the legacy option on the way through; runtime wiring.
  it("serves the fallback through the reader form and as an Effect", () => {
    const env = { [LEGACY]: FIXTURE_B64 };
    const reader = HeraConfig.keyring(KEYRING, options);
    expect(reader.envKey).toBe(KEYRING);
    expect(unwrapValid(reader.read(env)).activeKey).toEqual(FIXTURE_BYTES);

    const exit = Effect.runSyncExit(reader.effect(env));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(HeraConfig.unwrap(exit.value).activeVersion).toBe("v1");
    }

    const failed = Effect.runSyncExit(reader.effect({ [LEGACY]: "not base64" }));
    expect(Exit.isFailure(failed)).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("not base64");
  });

  // admits: switching to the keyring changing the active key, orphaning wrapped DEKs; byte equality is runtime.
  it("switches over to a keyring holding the same bytes with no change to the active key", () => {
    const fromLegacy = unwrapValid(HeraConfig.keyring({ [LEGACY]: FIXTURE_B64 }, KEYRING, options));
    const fromKeyring = unwrapValid(
      HeraConfig.keyring({ [KEYRING]: `v1:${FIXTURE_HEX}`, [LEGACY]: FIXTURE_B64 }, KEYRING, options),
    );
    expect(fromKeyring.activeVersion).toBe(fromLegacy.activeVersion);
    expect(fromKeyring.activeKey).toEqual(fromLegacy.activeKey);
  });
});
