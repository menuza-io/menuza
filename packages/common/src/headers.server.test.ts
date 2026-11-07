import { describe, expect, it } from 'vitest'
import { getValidatedHost } from './headers.server.ts'

const BASE = 'https://app.example.com'

function req(headers: Record<string, string>) {
	return new Request('https://app.example.com/resources/healthcheck', {
		headers,
	})
}

describe('getValidatedHost', () => {
	it('accepts loopback and BASE_URL hosts, with a port', () => {
		expect(
			getValidatedHost(req({ 'x-forwarded-host': 'localhost:3001' }), BASE),
		).toBe('localhost:3001')
		expect(getValidatedHost(req({ host: 'app.example.com' }), BASE)).toBe(
			'app.example.com',
		)
		expect(
			getValidatedHost(
				req({ 'x-forwarded-host': 'admin.app.example.com' }),
				BASE,
			),
		).toBe('admin.app.example.com')
	})

	it('refuses a forwarded host that smuggles another destination', () => {
		for (const forwarded of [
			'localhost:80@attacker.example',
			'app.example.com@attacker.example',
			'localhost/../@attacker.example',
			'localhost:80/x',
			'localhost#@attacker.example',
		]) {
			const host = getValidatedHost(
				req({ 'x-forwarded-host': forwarded }),
				BASE,
			)
			// Never the smuggled destination: the BASE_URL host instead.
			expect(host).toBe('app.example.com')
		}
	})

	it('accepts an explicit default port and bracketed IPv6 loopback', () => {
		expect(
			getValidatedHost(req({ 'x-forwarded-host': 'localhost:80' }), BASE),
		).toBe('localhost')
		expect(
			getValidatedHost(req({ 'x-forwarded-host': '[::1]:3000' }), BASE),
		).toBe('[::1]:3000')
	})

	it('never returns a client-chosen Host outside the allowlist', () => {
		expect(
			getValidatedHost(
				req({ 'x-forwarded-host': 'attacker.example', host: 'evil.example' }),
				BASE,
			),
		).toBe('app.example.com')
	})

	it('falls back only to a bare Host header', () => {
		expect(
			getValidatedHost(
				req({
					'x-forwarded-host': 'attacker.example',
					host: 'app.example.com',
				}),
				BASE,
			),
		).toBe('app.example.com')
		const host = getValidatedHost(
			req({
				'x-forwarded-host': 'localhost:80@attacker.example',
				host: 'app.example.com',
			}),
			BASE,
		)
		expect(host).toBe('app.example.com')
		expect(new URL(`http://${host}`).hostname).toBe('app.example.com')
	})
})
