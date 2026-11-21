# Schemas, Branded IDs & 3-State Configuration (`HeraSchema`, `HeraConfig`)

`@sibylline-labs/hera/schema` (`src/core/schema/`) and `@sibylline-labs/hera/config` (`src/core/config/`) provide nominal branded identifiers, value-stripping `effect/Schema` decoders, and 3-state environment secret/keyring readers for Worker services and CLIs.

---

## 1. Branded Identifiers & Eris Primitives (`@sibylline-labs/hera/schema`)

Hera wraps `effect/Schema` (`HeraSchema`) with nominal branded types so tenant, actor, and resource identifiers cannot be mixed at compile time or runtime.

### Built-In Branded Schemas

| Schema | Format / Invariant | Example |
|---|---|---|
| `HeraSchema.OrgId` (`OrgId`) | `org_<ULID>` (canonical); bare `<ULID>` accepted as an alias, kept verbatim | `"org_01HZX8VQXZ9K0M1N2P3Q4R5S6T"` |
| `HeraSchema.ActorId` (`ActorId`) | `act_<ULID>` | `"act_01HZX8VQXZ9K0M1N2P3Q4R5S6T"` |
| `HeraSchema.RequestId` (`RequestId`) | `req_<ULID>` | `"req_01HZX8VQXZ9K0M1N2P3Q4R5S6T"` |
| `HeraSchema.Ulid` (`Ulid`) | 26-char Crockford Base32 ULID | `"01HZX8VQXZ9K0M1N2P3Q4R5S6T"` |
| `HeraSchema.EventId` / `DeliveryId` / `SubscriptionId` / `AccountId` / `MemberId` | Prefixed ULIDs (`evt_`, `dlv_`, `sub_`, `acc_`, `mem_`) | `"evt_01HZX8VQXZ9K0M1N2P3Q4R5S6T"` |
| `HeraSchema.YakId` | `yak-<hex>` (4 to 16 lowercase hex chars) | `"yak-0123abcd"` |
| `HeraSchema.ClusterId` | `cls_<ULID>` | `"cls_01HZX8VQXZ9K0M1N2P3Q4R5S6T"` |
| `HeraSchema.LinearIdentifier` | `<TEAM>-<NUMBER>` (the team key may carry digits) | `"ABC-123"`, `"4U-12"` |
| `HeraSchema.Srn` (`Srn`) | `srn:sibylline:<service>:<env>:<kind>:<id>` (or the compact `srn:<kind>:<locator>`), where `<kind>` is one of `SRN_KINDS` | `"srn:sibylline:billing-api:prod:secret:DATABASE_URL"` |
| `HeraSchema.ServiceName` (`ServiceName`) | Lowercase kebab-case service slug | `"billing-api"` |
| `HeraSchema.EnvName` (`EnvName`) | Kebab-case environment name (1 to 32 chars). Canonical values: `local`, `dev`, `staging`, `prod`, `prod-uc1`, `preview`, `test`, `global` | `"prod"` |
| `HeraSchema.KeyName` (`KeyName`) | `UPPER_SNAKE_CASE` env/config key name | `"APP_MASTER_KEY"` |
| `HeraSchema.GcpProjectId` (`GcpProjectId`) | Google Cloud project id (6 to 30 chars, starts with a letter) | `"example-proj-01"` |
| `HeraSchema.LogfireProject` (`LogfireProject`) | Logfire project name: 1 to 50 lowercase alphanumerics with single inner hyphens (the Logfire SDK's rule). Not a GCP project id, so use `GcpProjectId` only for GCP | `"billing-api"` |
| `HeraSchema.ErrorSlug` (`ErrorSlug`) | Lowercase kebab-case CLI error slug | `"config-missing-key"` |

### Custom Branded IDs (`HeraSchema.brandedId`)

`HeraSchema.brandedId(brandName, pattern, meta?)` takes the brand name, a `RegExp` the whole string must match, and optional `{ identifier, title, description, examples }` annotations. The built-in IDs above are all made this way.

```ts
import { HeraSchema } from "@sibylline-labs/hera";

export const OrderId = HeraSchema.brandedId("OrderId", /^ord_[0-9A-HJKMNP-TV-Z]{26}$/, {
  description: "Prefixed ULID order identifier (ord_<ULID>)",
});
export type OrderId = typeof OrderId.Type;

const id = OrderId.make("ord_01HZX8VQXZ9K0M1N2P3Q4R5S6T");
```

### Value-Stripping Decoding (`HeraSchema.decode`, `HeraSchema.decodeResult`)

Standard schema libraries often include the rejected input value in error messages (e.g., `Expected OrgId, actual "sk_live_secret..."`), risking credential leaks in logs or HTTP 400 responses. `HeraSchema.decode` and `HeraSchema.decodeResult` strip rejected values and emit only `{ path, expected, code, message }`:

```ts
import * as Schema from "effect/Schema";
import { Hera, HeraSchema, OrgId } from "@sibylline-labs/hera";

const PayloadSchema = Schema.Struct({
  orgId: OrgId,
  service: HeraSchema.ServiceName,
});

const parsePayload = Hera.fn("Config.parsePayload")(function* (raw: unknown) {
  // Yields HeraSchemaError on invalid input with zero raw-value echoing
  return yield* Hera.decode(PayloadSchema, raw);
});
```

### Strict Decoding for Operator-Authored Config (`HeraSchema.decodeResultStrict`)

The default decoders strip object keys a schema does not declare, which is right for wire contracts. For config an operator writes by hand (YAML policy blocks, profiles), a typo such as `gate:` for `gates:` would vanish silently. `HeraSchema.decodeResultStrict`, `HeraSchema.decodeSyncStrict` and `HeraSchema.decodeUnknownEffectStrict` decode with `onExcessProperty: "error"` instead: each unknown key, at any depth, is one `UnexpectedKey` issue whose path ends in `$key`. Neither the key nor its value is echoed. `Schema.Record` keys are data, so a record still accepts any key.

```ts
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HeraSchema } from "@sibylline-labs/hera";

const Profile = Schema.Struct({ gates: Schema.Array(Schema.String) });

const decoded = HeraSchema.decodeResultStrict(Profile, { gates: [], gate: ["plan-review"] });
if (Result.isFailure(decoded)) {
  // [{ path: ["$key"], code: "UnexpectedKey", expected: "no unexpected keys", message: "Unexpected key in object" }]
  console.error(decoded.failure.issues);
}
```

---

## 2. 3-State Secret & Keyring Configuration (`@sibylline-labs/hera/config`)

In Cloudflare Workers and distributed services, a secret or encryption key can be in one of three states:
1. **`Unconfigured`**: The environment variable is unset or empty. A failed read surfaces as `HeraConfigError` and maps to `503 <key>_unconfigured` (for `LINEAR_WEBHOOK_SECRET`, `linear_webhook_secret_unconfigured`).
2. **`Invalid`**: The environment variable is present but malformed (e.g. wrong hex length, a malformed keyring entry). It maps to `503 <key>_invalid_config`.
3. **`Valid<T>`**: The value is present, stripped of one trailing `\r?\n` (protecting against `echo "..." | wrangler secret put`), validated, and wrapped in `Redacted<T>`.

### Reading Secrets, 32-Byte Hex Keys & Keyrings

Each reader (`HeraConfig.secret(envKey, schema)`, `HeraConfig.hexKey(envKey, byteLength?)`, `HeraConfig.keyring(envKey, options?)`) can be yielded directly. It reads the `HeraEnv` in context and yields a `Redacted<T>`, failing with `HeraConfigError` when the state is `Unconfigured` or `Invalid`. `HeraConfig.unwrap(redacted)` is synchronous: call it only at the trusted crypto or egress boundary. A keyring is the comma-separated string `v1:<hex>,v2:<hex>`, and the highest version number is the active key.

```ts
import * as Schema from "effect/Schema";
import { Hera, HeraConfig } from "@sibylline-labs/hera";

export const readWorkerSecrets = Hera.fn("Worker.readSecrets")(function* () {
  // 1. Redacted string secret (strips a trailing \n / \r\n automatically)
  const webhookSecret = HeraConfig.unwrap(
    yield* HeraConfig.secret("LINEAR_WEBHOOK_SECRET", Schema.String),
  );

  // 2. 32-byte (64-hex-char) cryptographic key -> Uint8Array(32)
  const masterKeyBytes = HeraConfig.unwrap(yield* HeraConfig.hexKey("APP_MASTER_KEY"));

  // 3. Versioned keyring: the highest version is active
  const keyring = HeraConfig.unwrap(yield* HeraConfig.keyring("APP_KEYRING"));

  return {
    hasWebhookSecret: webhookSecret.length > 0,
    masterKeyLength: masterKeyBytes.byteLength,
    activeVersion: keyring.activeVersion,
    activeKeyLength: keyring.activeKey.byteLength,
    hasPreviousKey: keyring.has("v1"),
  };
});
```

### Moving From One Key to a Keyring (`legacy`)

A service that holds a single unversioned key can adopt `HeraConfig.keyring` before its keyring secret exists. Pass `legacy` with the old key's name: while the keyring slot is unset, a padded standard-base64 value of exactly `byteLength` bytes under `legacy.key` (one trailing `\r?\n` stripped) loads as a one-entry keyring at `legacy.version`, and that entry is active. `byteLength` is required with `legacy`. A set keyring always wins and the legacy key is not read; a set but malformed keyring is `Invalid` and never falls back. A status read from the legacy key carries the legacy key's name as `envKey`, so a malformed legacy value is `Invalid` on it (`503 <legacy key>_invalid_config`); no reason echoes the value. A malformed `legacy` option itself (a `version` that is not `v<N>`, an unsupported `encoding`, a legacy key named like the keyring) is `Invalid` on the keyring key whatever the env holds. Without `legacy` the reader is unchanged.

```ts
import { Hera, HeraConfig } from "@sibylline-labs/hera";

export const readKek = Hera.fn("Accounts.readKek")(function* () {
  const keyring = HeraConfig.unwrap(
    yield* HeraConfig.keyring("LINEAR_TOKEN_KEYRING", {
      byteLength: 32,
      legacy: { key: "LINEAR_TOKEN_KEK", encoding: "base64", version: "v1" },
    }),
  );
  return { activeVersion: keyring.activeVersion };
});
```

To switch over, set the keyring with the same bytes as hex at the same version (`v1:<hex>`), plus any new version; the active key is unchanged for `v1`, so data wrapped under the legacy key stays readable.

### Providing Environment Bindings (`HeraConfig.layer`)

Bind a Cloudflare Worker `env` object or test dictionary to `HeraEnv` with `HeraConfig.layer(env)`:

```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Hera, HeraConfig } from "@sibylline-labs/hera";

const readWebhookSecret = Hera.fn("Worker.readWebhookSecret")(function* () {
  const secret = yield* HeraConfig.secret("LINEAR_WEBHOOK_SECRET", Schema.String);
  return HeraConfig.unwrap(secret).length;
});

export const program = readWebhookSecret().pipe(
  Effect.provide(
    HeraConfig.layer({
      LINEAR_WEBHOOK_SECRET: "whsec_live_example\n",
      APP_MASTER_KEY: "a".repeat(64),
      APP_KEYRING: `v1:${"1".repeat(64)},v2:${"2".repeat(64)}`,
    }),
  ),
);
```

### Logfire Managed Variables With a Code Fallback (`HeraConfig.managedVariables`)

A value that should change without a deploy (a rate limit, a knob) lives in a Logfire managed variable, and the code holds the value used when Logfire cannot answer. `HeraConfig.managedVariables({ token })` returns a reader; `get(name, schema, fallback)` reads `GET {base}/v1/variables/{name}/` with the project key, resolves the value the rollout serves (the heaviest of `rollout.labels` and `rollout.latest_weight`, a tie going to `latest`), decodes it through `schema`, and answers `{ value, source: "variable" }`. It never fails: any other outcome answers `{ value: fallback, source: "fallback", reason }`, where `reason` is one of `unconfigured` (no token), `unreachable`, `rejected` (a non-2xx other than 404), `absent`, `unparseable` or `invalid` (the schema refused it). No reason carries the token or a response body.

Each name is read once per `ttlMs` (default 60 s, on the Effect `Clock`), a failed read included, so an outage costs one call a minute; the reader holds its settled answers in a [`HeraCache`](caching.md), and reads that miss together each make their own call. Hold one reader per isolate or Durable Object, and log the `reason` when `source` is `fallback`.

```ts
import { Hera, HeraConfig } from "@sibylline-labs/hera";
import { Redacted } from "effect";
import * as Schema from "effect/Schema";

declare const env: { readonly LOGFIRE_READ_TOKEN?: string };

const vars = HeraConfig.managedVariables({
  token: env.LOGFIRE_READ_TOKEN ? Redacted.make(env.LOGFIRE_READ_TOKEN) : undefined,
});
const Limit = Schema.Struct({ capacity: Schema.Number, refillPerSecond: Schema.Number });

export const currentLimit = Hera.fn("Limits.current")(function* () {
  const limit = yield* vars.get("ratelimit_graph_l3", Limit, { capacity: 600, refillPerSecond: 10 });
  return limit.value;
});
```

## 3. Wire Contracts Live Outside the Framework

Hera carries no product wire contract. Versioned contracts that services share on the wire (a graph
ingest, a yak submission, a gate receipt) belong in a package of their own that takes
`@sibylline-labs/hera` and `effect` as peer dependencies and decodes with the `HeraSchema` decoders
above:

```ts
import * as Schema from "effect/Schema"
import { decodeUnknownSync, OrgId } from "@sibylline-labs/hera/schema"

export const WIDGET_CONTRACT_VERSION = "1.0.0" as const
export const WidgetSchema = Schema.Struct({
  schema_version: Schema.Literal(WIDGET_CONTRACT_VERSION),
  org_id: OrgId,
  name: Schema.String,
})

const widget = decodeUnknownSync(WidgetSchema)({ schema_version: "1.0.0", org_id: "org_01HZY3N8Q2W5K7M9P1R3T5V7X9", name: "w" })
```
