/** Route-driven fetch stub: records every call's url + headers for assertions. */

export interface StubbedCall {
  url: string
  headers: Record<string, string>
}

export interface StubResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Raw body text (wins over body); use for unparsable-JSON cases. */
  text?: string
  /** Throw instead of responding (network error). */
  throwError?: Error
}

export function stubFetch(route: (url: string, callIndex: number) => StubResponse): {
  fetchImpl: typeof fetch
  calls: StubbedCall[]
} {
  const calls: StubbedCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    })
    const spec = route(url, calls.length - 1)
    if (spec.throwError) throw spec.throwError
    const status = spec.status ?? 200
    const text = spec.text ?? JSON.stringify(spec.body ?? null)
    const responseInit: ResponseInit = { status, headers: spec.headers ?? {} }
    // Response refuses bodies on 304; construct it bodyless.
    return status === 304 ? new Response(null, responseInit) : new Response(text, responseInit)
  }) as typeof fetch
  return { fetchImpl, calls }
}
