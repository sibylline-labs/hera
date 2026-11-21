import type { Context } from "@earendil-works/chord/context"
import type { ConversationId, Storage } from "@earendil-works/pi-durable"

/** The slice of Pi's `Storage` the resolver reads. */
export type OperationStorage = Pick<Storage, "scanSubmissions" | "conversation" | "findDocument" | "document">

/** The Pi operation a unit of work belongs to: `operationId` is the id given to `submit`. */
export interface HeraAgentOperation {
  readonly operationId: string
  readonly session: string
}

export interface HeraAgentOperationResolver {
  /** The running operation of a conversation (a child conversation resolves through its owner). */
  readonly forConversation: (conversationId: ConversationId) => Promise<HeraAgentOperation | undefined>
  /** The running operation whose conversation's provider `sessionId` (pi-ai's `options.sessionId`) is `sessionId`. */
  readonly forProviderSession: (sessionId: string | undefined) => Promise<HeraAgentOperation | undefined>
}

const PROVIDER_KIND = "pi.provider"
const PAGE = 100
const MAX_OWNER_DEPTH = 8

/**
 * Resolves operation attribution from Pi's durable submission records. `PiHarness` admits every
 * operation as a conversation submission keyed by `requestId = operationId` with `whenBusy:
 * "followUp"`, so a conversation runs one operation at a time: its earliest `placed` input with a
 * `requestId` is the running one.
 */
export function makeOperationResolver(storage: OperationStorage, context: Context): HeraAgentOperationResolver {
  const running = async (conversationId: ConversationId): Promise<HeraAgentOperation | undefined> => {
    const page = await storage.scanSubmissions({ conversationId, status: "placed", order: "ascending" }, PAGE, undefined, context)
    const record = page.items.find((s) => s.type === "input" && s.requestId !== undefined)
    return record?.requestId === undefined ? undefined : { operationId: record.requestId, session: String(conversationId) }
  }

  const forConversation: HeraAgentOperationResolver["forConversation"] = async (conversationId) => {
    let id: ConversationId | undefined = conversationId
    for (let depth = 0; id !== undefined && depth < MAX_OWNER_DEPTH; depth++) {
      const found = await running(id)
      if (found !== undefined) return found
      id = (await storage.conversation(id, context))?.owner?.conversationId
    }
    return undefined
  }

  const providerSession = async (conversationId: ConversationId): Promise<string | undefined> => {
    const record = await storage.findDocument({ kind: PROVIDER_KIND, scope: { kind: "conversation", conversationId } }, "current", context)
    const stored = record === undefined ? undefined : await storage.document(record.id, "current", context)
    const value = stored?.value.sessionId
    return typeof value === "string" ? value : undefined
  }

  const forProviderSession: HeraAgentOperationResolver["forProviderSession"] = async (sessionId) => {
    if (sessionId === undefined) return undefined
    const page = await storage.scanSubmissions({ status: "placed", order: "ascending" }, PAGE, undefined, context)
    for (const conversationId of new Set(page.items.map((s) => s.conversationId))) {
      if ((await providerSession(conversationId)) === sessionId) return forConversation(conversationId)
    }
    return undefined
  }

  return { forConversation, forProviderSession }
}
