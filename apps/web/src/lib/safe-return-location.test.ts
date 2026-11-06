import { describe, expect, it } from 'vitest'
import { getSafeReturnLocation } from './safe-return-location'

function post(referer?: string) {
	return new Request('https://web.example/api/cookie-consent', {
		method: 'POST',
		headers: referer ? { Referer: referer } : {},
	})
}

describe('getSafeReturnLocation', () => {
	it('returns the same-origin referer path', () => {
		expect(
			getSafeReturnLocation(post('https://web.example/pricing?a=1#x')),
		).toBe('/pricing?a=1#x')
	})

	it('falls back to / for a cross-origin or missing referer', () => {
		expect(getSafeReturnLocation(post('https://evil.example/x'))).toBe('/')
		expect(getSafeReturnLocation(post())).toBe('/')
	})

	it('never returns a scheme-relative location', () => {
		for (const path of [
			'//evil.example/x',
			'///evil.example/x',
			'/\\evil.example/x',
		]) {
			const location = getSafeReturnLocation(post(`https://web.example${path}`))
			expect(location).toMatch(/^\/(?![/\\])/)
			expect(new URL(location, 'https://web.example').origin).toBe(
				'https://web.example',
			)
		}
	})
})
