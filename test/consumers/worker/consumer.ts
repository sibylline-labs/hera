import "@total-typescript/ts-reset"
import * as Schema from "effect/Schema"
import { Hera, OrgId, type HeraRpcClient, type HeraRpcMethod } from "@sibylline-labs/hera"
export * as root from "@sibylline-labs/hera"
export * as durableObject from "@sibylline-labs/hera/durable-object"
export * as server from "@sibylline-labs/hera/server"
export * as worker from "@sibylline-labs/hera/worker"
export * as agentTelemetry from "@sibylline-labs/hera/agent/telemetry"
export * as agent from "@sibylline-labs/hera/agent"

const C0 = Schema.Struct({ orgId: OrgId, f0: Schema.String })
const C1 = Schema.Struct({ orgId: OrgId, f1: Schema.String })
const C2 = Schema.Struct({ orgId: OrgId, f2: Schema.String })
const C3 = Schema.Struct({ orgId: OrgId, f3: Schema.String })
const C4 = Schema.Struct({ orgId: OrgId, f4: Schema.String })
const C5 = Schema.Struct({ orgId: OrgId, f5: Schema.String })
const C6 = Schema.Struct({ orgId: OrgId, f6: Schema.String })
const C7 = Schema.Struct({ orgId: OrgId, f7: Schema.String })
const C8 = Schema.Struct({ orgId: OrgId, f8: Schema.String })
const C9 = Schema.Struct({ orgId: OrgId, f9: Schema.String })
const C10 = Schema.Struct({ orgId: OrgId, f10: Schema.String })
const C11 = Schema.Struct({ orgId: OrgId, f11: Schema.String })
const C12 = Schema.Struct({ orgId: OrgId, f12: Schema.String })
const C13 = Schema.Struct({ orgId: OrgId, f13: Schema.String })
const C14 = Schema.Struct({ orgId: OrgId, f14: Schema.String })
const C15 = Schema.Struct({ orgId: OrgId, f15: Schema.String })
const C16 = Schema.Struct({ orgId: OrgId, f16: Schema.String })
const C17 = Schema.Struct({ orgId: OrgId, f17: Schema.String })
const C18 = Schema.Struct({ orgId: OrgId, f18: Schema.String })
const C19 = Schema.Struct({ orgId: OrgId, f19: Schema.String })

export type ConsumerLargeRpc = {
  readonly m0: HeraRpcMethod<typeof C0, { readonly ok: 0 }>
  readonly m1: HeraRpcMethod<typeof C1, { readonly ok: 1 }>
  readonly m2: HeraRpcMethod<typeof C2, { readonly ok: 2 }>
  readonly m3: HeraRpcMethod<typeof C3, { readonly ok: 3 }>
  readonly m4: HeraRpcMethod<typeof C4, { readonly ok: 4 }>
  readonly m5: HeraRpcMethod<typeof C5, { readonly ok: 5 }>
  readonly m6: HeraRpcMethod<typeof C6, { readonly ok: 6 }>
  readonly m7: HeraRpcMethod<typeof C7, { readonly ok: 7 }>
  readonly m8: HeraRpcMethod<typeof C8, { readonly ok: 8 }>
  readonly m9: HeraRpcMethod<typeof C9, { readonly ok: 9 }>
  readonly m10: HeraRpcMethod<typeof C10, { readonly ok: 10 }>
  readonly m11: HeraRpcMethod<typeof C11, { readonly ok: 11 }>
  readonly m12: HeraRpcMethod<typeof C12, { readonly ok: 12 }>
  readonly m13: HeraRpcMethod<typeof C13, { readonly ok: 13 }>
  readonly m14: HeraRpcMethod<typeof C14, { readonly ok: 14 }>
  readonly m15: HeraRpcMethod<typeof C15, { readonly ok: 15 }>
  readonly m16: HeraRpcMethod<typeof C16, { readonly ok: 16 }>
  readonly m17: HeraRpcMethod<typeof C17, { readonly ok: 17 }>
  readonly m18: HeraRpcMethod<typeof C18, { readonly ok: 18 }>
  readonly m19: HeraRpcMethod<typeof C19, { readonly ok: 19 }>
}

export type ConsumerLargeClient = HeraRpcClient<ConsumerLargeRpc>

export function makeConsumerLargeClient(binding: ConsumerLargeRpc): ConsumerLargeClient {
  return Hera.rpcClient(() => binding, {
    service: "notebook",
    onTransportError: ({ method, retryable, errorName }) => {
      void method
      void retryable
      void errorName
    },
  })
}

