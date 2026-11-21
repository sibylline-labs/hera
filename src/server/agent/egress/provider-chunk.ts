/**
 * Reads what the meter needs from one raw Gemini stream chunk, as `onProviderStreamEvent` hands it
 * (`@google/genai` `GenerateContentResponse`): `usageMetadata` (running totals, so the last chunk is
 * the request's), `responseId`, and the AI Gateway's `cf-aig-log-id` response header from
 * `sdkHttpResponse.headers`.
 */
export interface ChunkUsage {
  readonly promptTokens: number
  readonly candidatesTokens: number
  readonly thoughtsTokens: number
  readonly cachedTokens: number
  readonly totalTokens: number
}

export interface ChunkReading {
  readonly usage: ChunkUsage | undefined
  readonly logId: string | undefined
  readonly responseId: string | undefined
}

export const GATEWAY_LOG_ID_HEADER = "cf-aig-log-id"

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null

const count = (u: unknown): number => (typeof u === "number" && Number.isFinite(u) && u >= 0 ? u : 0)

function header(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (!isRecord(headers)) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string" && value !== "") return value
  }
  return undefined
}

export function readChunk(chunk: unknown): ChunkReading {
  if (!isRecord(chunk)) return { usage: undefined, logId: undefined, responseId: undefined }
  const meta = chunk.usageMetadata
  const http = chunk.sdkHttpResponse
  return {
    usage: isRecord(meta)
      ? {
          promptTokens: count(meta.promptTokenCount),
          candidatesTokens: count(meta.candidatesTokenCount),
          thoughtsTokens: count(meta.thoughtsTokenCount),
          cachedTokens: count(meta.cachedContentTokenCount),
          totalTokens: count(meta.totalTokenCount),
        }
      : undefined,
    logId: isRecord(http) ? header(http.headers, GATEWAY_LOG_ID_HEADER) : undefined,
    responseId: typeof chunk.responseId === "string" && chunk.responseId !== "" ? chunk.responseId : undefined,
  }
}

/** Folds `next` into `acc`: the latest usage and the first ids seen win. */
export function foldReading(acc: ChunkReading, next: ChunkReading): ChunkReading {
  return {
    usage: next.usage ?? acc.usage,
    logId: acc.logId ?? next.logId,
    responseId: acc.responseId ?? next.responseId,
  }
}

export const EMPTY_READING: ChunkReading = { usage: undefined, logId: undefined, responseId: undefined }
