import { describe, expect, it } from 'vitest'
import { isSafeAnnouncementLink } from './safe-link.ts'

describe('isSafeAnnouncementLink', () => {
	it.each(['/page', '/', 'https://example.com/a', 'http://example.com'])(
		'accepts %s',
		(value) => {
			expect(isSafeAnnouncementLink(value)).toBe(true)
		},
	)

	it.each([
		'',
		'javascript:alert(1)',
		'//evil.com',
		'/\\evil.com',
		'/\t/evil.com',
		'/\n/evil.com',
		'/\r/evil.com',
		'page',
	])('rejects %s', (value) => {
		expect(isSafeAnnouncementLink(value)).toBe(false)
	})
})
