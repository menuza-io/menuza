import { verifySessionStorage } from '@repo/auth'
import { db, eq, User } from '@repo/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureLinguiRequestLocale } from '#app/modules/lingui/lingui.server.ts'
import { isTrustedProviderAvatarUrl } from '#app/utils/auth.server.ts'
import { onboardingEmailSessionKey } from './onboarding.tsx'
import {
	action,
	prefilledProfileKey,
	providerIdKey,
} from './onboarding_.$provider.tsx'

afterEach(() => vi.restoreAllMocks())

async function onboardingRequest(
	formFields: Record<string, string>,
	prefilled: Record<string, unknown>,
) {
	const verifySession = await verifySessionStorage.getSession()
	verifySession.set(onboardingEmailSessionKey, prefilled.email)
	verifySession.set(providerIdKey, 'provider-id-1')
	verifySession.set(prefilledProfileKey, prefilled)
	const cookie = (
		await verifySessionStorage.commitSession(verifySession)
	).split(';')[0]!
	const formData = new FormData()
	for (const [k, v] of Object.entries(formFields)) formData.append(k, v)
	return new Request('http://localhost:3000/onboarding/github', {
		method: 'POST',
		headers: { cookie },
		body: formData,
	})
}

describe('onboarding provider avatar', () => {
	it('never downloads a client-supplied imageUrl and still signs up', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const suffix = Math.random().toString(36).slice(2, 8)
		const email = `ssrf-${suffix}@example.test`
		const username = `ssrf_${suffix}`
		const request = await onboardingRequest(
			{
				username,
				name: 'Ssrf Tester',
				agreeToTermsOfServiceAndPrivacyPolicy: 'on',
				imageUrl: 'http://internal.test/x',
			},
			{ email, username },
		)

		await ensureLinguiRequestLocale(request)
		const response = (await action({
			request,
			params: { provider: 'github' },
			context: {},
		} as any)) as Response

		expect(response.status).toBe(302)
		const requested = fetchSpy.mock.calls.map(([input]) => String(input))
		expect(requested.some((u) => u.includes('internal.test'))).toBe(false)
		const [user] = await db.select().from(User).where(eq(User.email, email))
		expect(user?.username).toBe(username)
	})

	it('only trusts https provider avatar hosts', () => {
		expect(
			isTrustedProviderAvatarUrl('https://avatars.githubusercontent.com/u/1'),
		).toBe(true)
		expect(
			isTrustedProviderAvatarUrl('https://lh3.googleusercontent.com/a/x'),
		).toBe(true)
		for (const bad of [
			'http://avatars.githubusercontent.com/u/1',
			'http://internal.test/x',
			'https://169.254.169.254/latest',
			'https://avatars.githubusercontent.com.evil.test/x',
			'https://evilgoogleusercontent.com/x',
			'not a url',
		]) {
			expect(isTrustedProviderAvatarUrl(bad)).toBe(false)
		}
	})
})
