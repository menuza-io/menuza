import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('varlock/env', () => ({
	ENV: { SESSION_SECRET: 'test-session-secret-for-preview' },
}))

const { signSitePreviewToken, verifySitePreviewToken } =
	await import('./preview-token.server.ts')

describe('site preview tokens', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('accepts a token for the organization it was issued for', () => {
		expect(verifySitePreviewToken('org_1', signSitePreviewToken('org_1'))).toBe(
			true,
		)
	})

	it('rejects a token issued for another organization', () => {
		expect(verifySitePreviewToken('org_2', signSitePreviewToken('org_1'))).toBe(
			false,
		)
	})

	it('rejects missing, malformed, and tampered tokens', () => {
		expect(verifySitePreviewToken('org_1', null)).toBe(false)
		expect(verifySitePreviewToken('org_1', 'garbage')).toBe(false)
		const [expires] = signSitePreviewToken('org_1').split('.')
		expect(verifySitePreviewToken('org_1', `${expires}.deadbeef`)).toBe(false)
		const far = Number(expires) + 10_000
		expect(
			verifySitePreviewToken(
				'org_1',
				`${far}.${signSitePreviewToken('org_1').split('.')[1]}`,
			),
		).toBe(false)
	})

	it('returns a stable token within a bucket so revalidation does not remount the preview', () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:10Z'))
		const first = signSitePreviewToken('org_1')
		vi.setSystemTime(new Date('2026-01-01T00:05:00Z'))
		expect(signSitePreviewToken('org_1')).toBe(first)
	})

	it('rejects an expired token', () => {
		vi.useFakeTimers()
		const token = signSitePreviewToken('org_1')
		vi.advanceTimersByTime(2 * 60 * 60 * 1000)
		expect(verifySitePreviewToken('org_1', token)).toBe(false)
	})
})
