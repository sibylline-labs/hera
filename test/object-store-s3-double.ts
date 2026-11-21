import { createHash } from "node:crypto"

interface StoredObject {
  readonly body: Uint8Array
  readonly etag: string
  readonly lastModified: string
  readonly contentType?: string
  readonly meta: Record<string, string>
}

export interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * A `fetch` double that answers like R2's S3 endpoint for one bucket (path-style): conditional
 * PutObject / GetObject (`412` / `304`), `x-amz-meta-*`, HeadObject, ListObjectsV2 XML and
 * `<Error><Code>` bodies. It refuses (400) any request whose SigV4 `authorization` does not sign
 * `x-amz-content-sha256` and `x-amz-date`, or whose content hash disagrees with the body.
 */
export function makeS3Double(bucket: string) {
  const objects = new Map<string, StoredObject>()
  const requests: Array<RecordedRequest> = []
  const faults: Array<{ status: number; body: string; headers?: Record<string, string> }> = []
  let writes = 0

  const xmlError = (status: number, code: string) =>
    new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>m</Message></Error>`, {
      status,
      headers: { "content-type": "application/xml" },
    })

  const objectHeaders = (o: StoredObject): Headers => {
    const h = new Headers({
      etag: `"${o.etag}"`,
      "last-modified": o.lastModified,
      "content-length": String(o.body.byteLength),
    })
    if (o.contentType !== undefined) h.set("content-type", o.contentType)
    for (const [k, v] of Object.entries(o.meta)) h.set(`x-amz-meta-${k}`, v)
    return h
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    requests.push({ method, url: url.toString(), headers })
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(0)
    const sha = createHash("sha256").update(body).digest("hex")
    const auth = headers.authorization ?? ""
    if (
      !auth.startsWith("AWS4-HMAC-SHA256 Credential=") ||
      !/SignedHeaders=[^,]*host;[^,]*x-amz-content-sha256;x-amz-date/.test(auth) ||
      headers["x-amz-content-sha256"] !== sha
    ) {
      return xmlError(400, "InvalidRequest")
    }
    const fault = faults.shift()
    if (fault !== undefined) {
      return new Response(fault.body, { status: fault.status, headers: fault.headers ?? {} })
    }
    const [, bucketSeg, ...rest] = url.pathname.split("/")
    if (decodeURIComponent(bucketSeg ?? "") !== bucket) return xmlError(404, "NoSuchBucket")
    const key = rest.map(decodeURIComponent).join("/")

    if (key === "" && method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? ""
      const max = Number(url.searchParams.get("max-keys") ?? "1000")
      const after = url.searchParams.get("continuation-token")
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(prefix) && (after === null || k > after))
        .sort()
      const page = keys.slice(0, max)
      const truncated = keys.length > max
      const contents = page
        .map((k) => {
          const o = objects.get(k)!
          return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${new Date(o.lastModified).toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`
        })
        .join("")
      const next = truncated ? `<NextContinuationToken>${xmlEscape(page[page.length - 1]!)}</NextContinuationToken>` : ""
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`,
        { status: 200, headers: { "content-type": "application/xml" } }
      )
    }

    const current = objects.get(key)
    if (method === "PUT") {
      if (headers["if-none-match"] === "*" && current !== undefined) return xmlError(412, "PreconditionFailed")
      if (headers["if-match"] !== undefined && (current === undefined || headers["if-match"] !== `"${current.etag}"`)) {
        return xmlError(412, "PreconditionFailed")
      }
      writes += 1
      const meta: Record<string, string> = {}
      for (const [k, v] of Object.entries(headers)) {
        if (k.startsWith("x-amz-meta-")) meta[k.slice(11)] = v
      }
      const etag = createHash("md5").update(body).update(String(writes)).digest("hex")
      objects.set(key, {
        body: body.slice(),
        etag,
        lastModified: new Date(Date.UTC(2026, 9, 30, 12, 0, writes)).toUTCString(),
        ...(headers["content-type"] !== undefined ? { contentType: headers["content-type"] } : {}),
        meta,
      })
      return new Response(null, { status: 200, headers: { etag: `"${etag}"` } })
    }
    if (method === "GET" || method === "HEAD") {
      if (current === undefined) {
        return method === "HEAD" ? new Response(null, { status: 404 }) : xmlError(404, "NoSuchKey")
      }
      if (headers["if-none-match"] === "*" || headers["if-none-match"] === `"${current.etag}"`) {
        return new Response(null, { status: 304, headers: { etag: `"${current.etag}"` } })
      }
      return new Response(method === "HEAD" ? null : (current.body.slice() as BodyInit), {
        status: 200,
        headers: objectHeaders(current),
      })
    }
    return xmlError(405, "MethodNotAllowed")
  }

  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    objects,
    /** The next request gets this response instead (after the signature check). */
    failNext: (status: number, body: string, headers?: Record<string, string>) => {
      faults.push({ status, body, ...(headers !== undefined ? { headers } : {}) })
    },
    /** Deletes a key behind the client's back (a concurrent writer). */
    remove: (key: string) => objects.delete(key),
  }
}
