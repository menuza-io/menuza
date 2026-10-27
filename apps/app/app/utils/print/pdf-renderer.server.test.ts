import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderPdf, withoutRemoteFonts } from './pdf-renderer.server.ts'

const HTML =
	'<head><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=block"><style>p{}</style></head>'

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe('renderPdf', () => {
	it('drops only the web font links for the fallback', () => {
		expect(withoutRemoteFonts(HTML)).toBe('<head><style>p{}</style></head>')
	})

	it('retries once without web fonts when the first render fails', async () => {
		vi.stubEnv('PRINT_BROWSER_ACCOUNT_ID', 'acc')
		vi.stubEnv('PRINT_BROWSER_API_TOKEN', 'token')
		const pdf = new TextEncoder().encode('%PDF-1.7')
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('timeout', { status: 500 }))
			.mockResolvedValueOnce(
				new Response(pdf, { headers: { 'content-type': 'application/pdf' } }),
			)
		vi.stubGlobal('fetch', fetchMock)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const result = await renderPdf(HTML)
		expect(result.ok).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const retry = JSON.parse(fetchMock.mock.calls[1]![1].body as string) as {
			html: string
			gotoOptions: { waitUntil: string }
		}
		expect(retry.html).not.toContain('fonts.googleapis.com')
		expect(retry.gotoOptions.waitUntil).toBe('load')
	})

	it('does not retry when the account is the problem', async () => {
		vi.stubEnv('PRINT_BROWSER_ACCOUNT_ID', 'acc')
		vi.stubEnv('PRINT_BROWSER_API_TOKEN', 'token')
		const fetchMock = vi.fn(async () => new Response('no', { status: 403 }))
		vi.stubGlobal('fetch', fetchMock)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		expect((await renderPdf(HTML)).ok).toBe(false)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})
