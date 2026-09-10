import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('lazy draft file API', () => {
  it('requests one canonical path against the exact draft revision and digest', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      file: {
        path: 'docs/hello world.md',
        size: 5,
        digest: 'sha256:' + 'a'.repeat(64),
        previewState: 'text',
        content: 'aGVsbG8=',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.draftFile('draft/1', 'docs/hello world.md', {
      revision: 7,
      digest: 'sha256:' + 'b'.repeat(64) as `sha256:${string}`,
    })

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const url = new URL(path, 'https://registry.test')
    expect(url.pathname).toBe('/v1/drafts/draft%2F1/files')
    expect(url.searchParams.get('path')).toBe('docs/hello world.md')
    expect(url.searchParams.get('revision')).toBe('7')
    expect(url.searchParams.get('digest')).toBe('sha256:' + 'b'.repeat(64))
    expect(init.credentials).toBe('include')
    expect(result.file.path).toBe('docs/hello world.md')
  })
})
