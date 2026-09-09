import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	parseTurnstileHostnames,
	verifyTurnstileToken,
} from './turnstile.server'

describe('parseTurnstileHostnames', () => {
	it('normalizes and splits comma-separated hostnames', () => {
		expect(parseTurnstileHostnames(' localhost, ACME.example.com , ')).toEqual(
			new Set(['localhost', 'acme.example.com']),
		)
	})
})

describe('verifyTurnstileToken', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('rejects empty tokens without calling siteverify', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		const result = await verifyTurnstileToken({
			secret: 'secret',
			token: '',
		})

		expect(result.success).toBe(false)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('validates action and hostname on successful siteverify', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						action: 'website-form',
						hostname: 'acme.example.com',
					}),
					{ status: 200 },
				),
			),
		)

		const result = await verifyTurnstileToken({
			secret: 'secret',
			token: 'token',
			expectedAction: 'website-form',
			expectedHostnames: new Set(['acme.example.com']),
		})

		expect(result.success).toBe(true)
	})

	it('rejects hostname mismatches', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						action: 'website-form',
						hostname: 'evil.example.com',
					}),
					{ status: 200 },
				),
			),
		)

		const result = await verifyTurnstileToken({
			secret: 'secret',
			token: 'token',
			expectedAction: 'website-form',
			expectedHostnames: new Set(['acme.example.com']),
		})

		expect(result.success).toBe(false)
		expect(result['error-codes']).toContain('hostname-mismatch')
	})
})
