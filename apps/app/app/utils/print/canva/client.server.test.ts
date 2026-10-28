import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	canvaApi,
	canvaAuthorizeUrl,
	CanvaError,
	createPkce,
	downloadCanvaFile,
	exchangeCanvaCode,
	refreshCanvaTokens,
} from './client.server.ts'

const fetchMock = vi.fn<typeof fetch>()

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function requestAt(index: number) {
	const [url, init] = fetchMock.mock.calls[index]!
	return { url: String(url), init: init ?? {} }
}

beforeEach(() => {
	vi.stubEnv('CANVA_MOCK', '')
	vi.stubEnv('CANVA_CLIENT_ID', 'client-id')
	vi.stubEnv('CANVA_CLIENT_SECRET', 'client-secret')
	vi.stubEnv('BASE_URL', 'https://app.example.com')
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe('Canva OAuth', () => {
	it('builds an S256 PKCE authorize URL with the scopes and redirect', () => {
		const { verifier, challenge } = createPkce()
		expect(challenge).toBe(
			crypto.createHash('sha256').update(verifier).digest('base64url'),
		)
		const url = new URL(canvaAuthorizeUrl({ state: 'st', challenge }))
		expect(url.origin + url.pathname).toBe(
			'https://www.canva.com/api/oauth/authorize',
		)
		expect(Object.fromEntries(url.searchParams)).toEqual({
			code_challenge: challenge,
			code_challenge_method: 'S256',
			scope:
				'design:meta:read design:content:read design:content:write profile:read',
			response_type: 'code',
			client_id: 'client-id',
			state: 'st',
			redirect_uri: 'https://app.example.com/resources/print/canva/callback',
		})
	})

	it('exchanges the code with Basic auth and reads the expiry', async () => {
		fetchMock.mockResolvedValueOnce(
			json({
				access_token: 'at',
				refresh_token: 'rt',
				expires_in: 14400,
				scope: 'design:meta:read',
			}),
		)
		const before = Date.now()
		const tokens = await exchangeCanvaCode({ code: 'c', verifier: 'v' })
		expect(tokens.accessToken).toBe('at')
		expect(tokens.refreshToken).toBe('rt')
		expect(tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(
			before + 14_400_000,
		)
		const { url, init } = requestAt(0)
		expect(url).toBe('https://api.canva.com/rest/v1/oauth/token')
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
		)
		expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
			grant_type: 'authorization_code',
			code: 'c',
			code_verifier: 'v',
			redirect_uri: 'https://app.example.com/resources/print/canva/callback',
		})
	})

	it('reports a refused grant apart from other token errors', async () => {
		fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400))
		await expect(refreshCanvaTokens('spent')).rejects.toMatchObject({
			code: 'invalid_grant',
		})
		// A misconfigured client or a passing 401 is not a lost grant.
		fetchMock.mockResolvedValueOnce(json({ error: 'invalid_client' }, 401))
		await expect(refreshCanvaTokens('rt')).rejects.toMatchObject({
			code: 'unavailable',
		})
		fetchMock.mockResolvedValueOnce(json({}, 401))
		await expect(refreshCanvaTokens('rt')).rejects.toMatchObject({
			code: 'unavailable',
		})
	})

	it('refuses to call Canva without the integration keys', async () => {
		vi.stubEnv('CANVA_CLIENT_SECRET', '')
		await expect(refreshCanvaTokens('rt')).rejects.toMatchObject({
			code: 'unavailable',
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('Canva API', () => {
	it('exports page 1 as a pro PDF and polls the job', async () => {
		fetchMock
			.mockResolvedValueOnce(json({ job: { id: 'e1', status: 'in_progress' } }))
			.mockResolvedValueOnce(
				json({
					job: {
						id: 'e1',
						status: 'success',
						urls: ['https://export.canva.com/e1.pdf'],
					},
				}),
			)
		const url = await canvaApi('at').exportFirstPage('D1', {
			type: 'pdf',
			quality: 'pro',
		})
		expect(url).toBe('https://export.canva.com/e1.pdf')
		const first = requestAt(0)
		expect(first.url).toBe('https://api.canva.com/rest/v1/exports')
		expect(JSON.parse(String(first.init.body))).toEqual({
			design_id: 'D1',
			format: { type: 'pdf', export_quality: 'pro', pages: [1] },
		})
		expect(requestAt(1).url).toBe('https://api.canva.com/rest/v1/exports/e1')
	})

	it('reports a license failure of an export job', async () => {
		fetchMock.mockResolvedValueOnce(
			json({
				job: {
					id: 'e2',
					status: 'failed',
					error: { code: 'license_required', message: 'Pro' },
				},
			}),
		)
		await expect(
			canvaApi('at').exportFirstPage('D1', { type: 'pdf', quality: 'pro' }),
		).rejects.toMatchObject({ code: 'license_required' })
	})

	it('maps Canva answers to error codes', async () => {
		const api = canvaApi('at')
		for (const [status, code] of [
			[401, 'unauthorized'],
			[403, 'not_found'],
			[404, 'not_found'],
			[429, 'rate_limited'],
			[500, 'unavailable'],
		] as const) {
			fetchMock.mockResolvedValueOnce(json({ code: 'x' }, status))
			await expect(api.getDesign('D1')).rejects.toMatchObject({ code })
		}
		fetchMock.mockRejectedValueOnce(new TypeError('network'))
		await expect(api.getDesign('D1')).rejects.toBeInstanceOf(CanvaError)
	})

	it('reads designs with their edit link and thumbnail', async () => {
		fetchMock.mockResolvedValueOnce(
			json({
				items: [
					{
						id: 'D1',
						title: '',
						page_count: 2,
						thumbnail: { url: 'https://t/1.png', width: 297, height: 420 },
						urls: { edit_url: 'https://www.canva.com/design/D1/edit' },
					},
					{ title: 'no id' },
				],
				continuation: 'next',
			}),
		)
		const page = await canvaApi('at').listDesigns({ query: 'menu' })
		expect(page).toEqual({
			designs: [
				{
					id: 'D1',
					title: 'Untitled',
					pageCount: 2,
					thumbnail: { url: 'https://t/1.png', width: 297, height: 420 },
					editUrl: 'https://www.canva.com/design/D1/edit',
				},
			],
			continuation: 'next',
		})
		const search = new URL(requestAt(0).url).searchParams
		expect(search.get('query')).toBe('menu')
		expect(search.get('sort_by')).toBe('relevance')
	})

	it('imports a PDF with a base64 title of at most 50 characters', async () => {
		fetchMock.mockResolvedValueOnce(
			json({
				job: {
					id: 'i1',
					status: 'success',
					result: {
						designs: [
							{
								id: 'NEW',
								title: 'x',
								urls: { edit_url: 'https://www.canva.com/design/NEW/edit' },
							},
						],
					},
				},
			}),
		)
		const title = 'A'.repeat(60)
		const result = await canvaApi('at').importPdf(
			new Uint8Array(new ArrayBuffer(4)),
			title,
		)
		expect(result).toEqual({
			id: 'NEW',
			editUrl: 'https://www.canva.com/design/NEW/edit',
		})
		const headers = requestAt(0).init.headers as Record<string, string>
		expect(headers['Content-Type']).toBe('application/octet-stream')
		const metadata = JSON.parse(headers['Import-Metadata']!) as {
			title_base64: string
			mime_type: string
		}
		expect(Buffer.from(metadata.title_base64, 'base64').toString()).toBe(
			'A'.repeat(50),
		)
		expect(metadata.mime_type).toBe('application/pdf')
	})
})

describe('downloadCanvaFile', () => {
	it('downloads over https from Canva hosts only', async () => {
		for (const url of [
			'http://export.canva.com/a.pdf',
			'https://169.254.169.254/latest/meta-data',
			'https://127.0.0.1/a.pdf',
			'https://export.canva.com.evil.example/a.pdf',
			'https://export.canva.com:8443/a.pdf',
			'https://evil.example/a.pdf',
		]) {
			await expect(downloadCanvaFile(url)).rejects.toMatchObject({
				code: 'failed',
			})
		}
		expect(fetchMock).not.toHaveBeenCalled()
		fetchMock.mockResolvedValueOnce(
			new Response('%PDF-1.7', {
				headers: { 'Content-Type': 'application/pdf; charset=binary' },
			}),
		)
		const file = await downloadCanvaFile('https://export.canva.com/a.pdf')
		expect(new TextDecoder().decode(file.bytes)).toBe('%PDF-1.7')
		expect(file.contentType).toBe('application/pdf')
	})

	it('checks every redirect against the same rule', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { Location: 'https://cdn.canva.com/a.pdf' },
			}),
		)
		fetchMock.mockResolvedValueOnce(new Response('%PDF-1.7'))
		const file = await downloadCanvaFile('https://export.canva.com/a.pdf')
		expect(new TextDecoder().decode(file.bytes)).toBe('%PDF-1.7')
		expect(String(requestAt(1).url)).toBe('https://cdn.canva.com/a.pdf')

		fetchMock.mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { Location: 'http://169.254.169.254/latest' },
			}),
		)
		await expect(
			downloadCanvaFile('https://export.canva.com/a.pdf'),
		).rejects.toMatchObject({ code: 'failed' })
		fetchMock.mockResolvedValueOnce(
			new Response(null, {
				status: 301,
				headers: { Location: 'https://internal.example/a.pdf' },
			}),
		)
		await expect(
			downloadCanvaFile('https://export.canva.com/a.pdf'),
		).rejects.toMatchObject({ code: 'failed' })
		expect(fetchMock).toHaveBeenCalledTimes(4)
	})

	it('stops at the size cap, declared or streamed', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response('x', { headers: { 'Content-Length': '99' } }),
		)
		await expect(
			downloadCanvaFile('https://export.canva.com/a.pdf', { maxBytes: 10 }),
		).rejects.toMatchObject({ code: 'too_large' })
		fetchMock.mockResolvedValueOnce(new Response('x'.repeat(11)))
		await expect(
			downloadCanvaFile('https://export.canva.com/a.pdf', { maxBytes: 10 }),
		).rejects.toMatchObject({ code: 'too_large' })
	})
})
