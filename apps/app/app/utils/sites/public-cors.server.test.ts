import { describe, expect, it } from 'vitest'
import { withPublicCors } from './public-cors.server.ts'

const args = {
	request: new Request('https://app.test/resources/sites?slug=x'),
	params: {},
	context: {},
} as never

describe('withPublicCors', () => {
	it('adds public CORS headers to a normal response and keeps the rest', async () => {
		const wrapped = withPublicCors(async () =>
			Response.json(
				{ ok: true },
				{
					status: 200,
					headers: {
						'Cache-Control': 'public, max-age=60',
						Vary: 'Accept-Language',
					},
				},
			),
		)
		const response = await wrapped(args)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(response.headers.get('cache-control')).toBe('public, max-age=60')
		expect(response.headers.get('vary')).toBe('Accept-Language')
		expect(await response.json()).toEqual({ ok: true })
	})

	it('never allows credentials', async () => {
		const response = await withPublicCors(async () => Response.json({}))(args)
		expect(response.headers.get('access-control-allow-credentials')).toBeNull()
	})

	it('adds the headers to thrown responses so a browser can read a 404 or 429', async () => {
		const wrapped = withPublicCors(async () => {
			throw new Response('Not Found', { status: 404 })
		})
		const thrown = await wrapped(args).catch((e: unknown) => e)
		expect(thrown).toBeInstanceOf(Response)
		expect((thrown as Response).status).toBe(404)
		expect(
			(thrown as Response).headers.get('access-control-allow-origin'),
		).toBe('*')
	})

	it('does not swallow real errors', async () => {
		const wrapped = withPublicCors(async () => {
			throw new Error('boom')
		})
		await expect(wrapped(args)).rejects.toThrow('boom')
	})
})
