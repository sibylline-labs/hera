import { unquoteEtag } from "./metadata.js"

export interface ListObjectsV2Page {
  readonly contents: ReadonlyArray<{
    readonly key: string
    readonly etag: string
    readonly size: number
    readonly uploaded: number
  }>
  readonly truncated: boolean
  readonly nextContinuationToken?: string | undefined
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, ref: string) => {
    if (ref.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(ref.slice(2), 16))
    }
    if (ref.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(ref.slice(1), 10))
    }
    return ENTITIES[ref] ?? ""
  })
}

function element(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return match?.[1] === undefined ? undefined : decodeXml(match[1])
}

/**
 * Parses an S3 `ListObjectsV2` reply (bun has no `DOMParser`). `null` when the body is not a
 * `ListBucketResult` or an entry lacks its `Key`.
 */
export function parseListObjectsV2(xml: string): ListObjectsV2Page | null {
  if (!xml.includes("<ListBucketResult")) {
    return null
  }
  const contents: Array<ListObjectsV2Page["contents"][number]> = []
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const entry = match[1] ?? ""
    const key = element(entry, "Key")
    if (key === undefined) {
      return null
    }
    const modified = Date.parse(element(entry, "LastModified") ?? "")
    contents.push({
      key,
      etag: unquoteEtag(element(entry, "ETag") ?? ""),
      size: Number(element(entry, "Size") ?? "0"),
      uploaded: Number.isFinite(modified) ? modified : 0,
    })
  }
  const token = element(xml, "NextContinuationToken")
  return {
    contents,
    truncated: element(xml, "IsTruncated") === "true",
    ...(token !== undefined && token !== "" ? { nextContinuationToken: token } : {}),
  }
}

/** The `<Code>` of an S3 `<Error>` body (`AccessDenied`, `NoSuchBucket`, …), bounded to a token. */
export function parseS3ErrorCode(body: string | undefined): string | undefined {
  const code = body === undefined ? undefined : element(body, "Code")
  return code !== undefined && /^[A-Za-z0-9.]{1,64}$/.test(code) ? code : undefined
}
