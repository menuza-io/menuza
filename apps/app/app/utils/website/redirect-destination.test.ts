import { describe, expect, it } from 'vitest'
import { isValidRedirectDestination } from './redirect-destination.ts'

describe('isValidRedirectDestination', () => {
	it.each(['/page', '/', 'https://example.com/a', 'http://example.com'])(
		'accepts %s',
		(value) => {
			expect(isValidRedirectDestination(value)).toBe(true)
		},
	)

	it.each([
		'',
		'javascript:alert(1)',
		'data:text/html,hi',
		'//evil.com',
		'/\\evil.com',
		'page',
		'/\t/evil.com',
		'/\n/evil.com',
		'/\r/evil.com',
	])('rejects %s', (value) => {
		expect(isValidRedirectDestination(value)).toBe(false)
	})
})
