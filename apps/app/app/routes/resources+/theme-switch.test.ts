import { describe, expect, it } from 'vitest'
import { getResponseHeaders, getResponseStatus } from '#tests/test-utils.ts'
import { action } from './theme-switch.tsx'

describe('theme-switch action', () => {
	it('sets dark theme in cookie', async () => {
		const formData = new FormData()
		formData.append('theme', 'dark')

		const request = new Request(
			'http://localhost:3000/resources/theme-switch',
			{
				method: 'POST',
				body: formData,
			},
		)

		const response = await action({
			request,
			params: {},
			context: {},
		} as any)

		expect(getResponseStatus(response)).toBe(200)
		const headers = getResponseHeaders(response)
		const setCookie = headers.get('set-cookie')
		expect(setCookie).toBeDefined()
		expect(setCookie).toContain('theme=dark')
	})

	it('sets light theme in cookie', async () => {
		const formData = new FormData()
		formData.append('theme', 'light')

		const request = new Request(
			'http://localhost:3000/resources/theme-switch',
			{
				method: 'POST',
				body: formData,
			},
		)

		const response = await action({
			request,
			params: {},
			context: {},
		} as any)

		expect(getResponseStatus(response)).toBe(200)
		const headers = getResponseHeaders(response)
		const setCookie = headers.get('set-cookie')
		expect(setCookie).toBeDefined()
		expect(setCookie).toContain('theme=light')
	})

	it('sets system theme in cookie', async () => {
		const formData = new FormData()
		formData.append('theme', 'system')

		const request = new Request(
			'http://localhost:3000/resources/theme-switch',
			{
				method: 'POST',
				body: formData,
			},
		)

		const response = await action({
			request,
			params: {},
			context: {},
		} as any)

		expect(getResponseStatus(response)).toBe(200)
		const headers = getResponseHeaders(response)
		const setCookie = headers.get('set-cookie')
		expect(setCookie).toBeDefined()
		expect(setCookie).toContain('Max-Age=-1')
	})

	it('redirects to redirectTo parameter when supplied', async () => {
		const formData = new FormData()
		formData.append('theme', 'dark')
		formData.append('redirectTo', '/dashboard')

		const request = new Request(
			'http://localhost:3000/resources/theme-switch',
			{
				method: 'POST',
				body: formData,
			},
		)

		const response = (await action({
			request,
			params: {},
			context: {},
		} as any)) as Response

		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe('/dashboard')
		expect(response.headers.get('set-cookie')).toContain('theme=dark')
	})

	it.each(['//evil.com', '/\\evil.com', 'https://evil.com'])(
		'does not redirect to external target %s',
		async (target) => {
			const formData = new FormData()
			formData.append('theme', 'dark')
			formData.append('redirectTo', target)
			const response = (await action({
				request: new Request('http://localhost:3000/resources/theme-switch', {
					method: 'POST',
					body: formData,
				}),
				params: {},
				context: {},
			} as any)) as unknown as {
				init?: { headers?: Record<string, string> }
				status?: number
			}
			// Falls back to a data() response (no Location header) with the cookie set.
			expect(response.status).not.toBe(302)
			expect(response.init?.headers?.['set-cookie']).toContain('theme=dark')
		},
	)

	it('throws 400 when theme is invalid', async () => {
		const formData = new FormData()
		formData.append('theme', 'neon-purple')

		const request = new Request(
			'http://localhost:3000/resources/theme-switch',
			{
				method: 'POST',
				body: formData,
			},
		)

		try {
			await action({
				request,
				params: {},
				context: {},
			} as any)
			expect.fail('Expected action to throw on invalid theme')
		} catch (error: any) {
			expect(error).toBeInstanceOf(Response)
			expect(error.status).toBe(400)
		}
	})
})
