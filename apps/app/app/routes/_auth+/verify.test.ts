import { generateTOTP } from '@epic-web/totp'
import { authSessionStorage } from '@repo/auth'
import { db, eq, Verification } from '@repo/database'

import { describe, expect, it } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	getResponseStatus,
} from '#tests/test-utils.ts'
import { action } from './verify.tsx'

describe('verify route integration', () => {
	it('returns 400 when required fields are missing', async () => {
		const formData = new FormData()

		const request = new Request('http://localhost:3000/verify', {
			method: 'POST',
			body: formData,
		})

		const response = await action({
			request,
			params: {},
			context: {},
		} as any)

		expect(getResponseStatus(response)).toBe(400)
	})

	it('returns 400 on invalid or non-existent verification code', async () => {
		const user = await createTestUser()

		const formData = new FormData()
		formData.append('type', 'reset-password')
		formData.append('target', user.email.toLowerCase())
		formData.append('code', '000000')

		const request = new Request('http://localhost:3000/verify', {
			method: 'POST',
			body: formData,
		})

		const response = await action({
			request,
			params: {},
			context: {},
		} as any)

		expect(getResponseStatus(response)).toBe(400)
	})

	it('successfully verifies reset-password and redirects to /reset-password with session cookie', async () => {
		const user = await createTestUser()

		const secret = 'JBSWY3DPEHPK3PXP'
		const { otp } = await generateTOTP({
			secret,
			algorithm: 'SHA-1',
			period: 600,
			digits: 6,
		})

		await db.insert(Verification).values({
			type: 'reset-password',
			target: user.email.toLowerCase(),
			secret,
			algorithm: 'SHA-1',
			digits: 6,
			period: 600,
			charSet: '0123456789',
			expiresAt: new Date(Date.now() + 1000 * 60 * 10),
		})

		const formData = new FormData()
		formData.append('type', 'reset-password')
		formData.append('target', user.email.toLowerCase())
		formData.append('code', otp)

		const request = new Request('http://localhost:3000/verify', {
			method: 'POST',
			body: formData,
		})

		const response = (await action({
			request,
			params: {},
			context: {},
		} as any)) as Response

		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toContain('/reset-password')
		expect(response.headers.get('set-cookie')).toBeDefined()

		// Verify verification row was consumed/deleted
		const [verificationAfter] = await db
			.select()
			.from(Verification)
			.where(eq(Verification.target, user.email.toLowerCase()))
			.limit(1)

		expect(verificationAfter).toBeUndefined()
	})

	it('successfully verifies onboarding and redirects to /onboarding', async () => {
		const email = `onboarding_${Date.now()}@example.com`

		const secret = 'JBSWY3DPEHPK3PXP'
		const { otp } = await generateTOTP({
			secret,
			algorithm: 'SHA-1',
			period: 600,
			digits: 6,
		})

		await db.insert(Verification).values({
			type: 'onboarding',
			target: email.toLowerCase(),
			secret,
			algorithm: 'SHA-1',
			digits: 6,
			period: 600,
			charSet: '0123456789',
			expiresAt: new Date(Date.now() + 1000 * 60 * 10),
		})

		const formData = new FormData()
		formData.append('type', 'onboarding')
		formData.append('target', email.toLowerCase())
		formData.append('code', otp)

		const request = new Request('http://localhost:3000/verify', {
			method: 'POST',
			body: formData,
		})

		const response = (await action({
			request,
			params: {},
			context: {},
		} as any)) as Response

		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toContain('/onboarding')
	})

	describe('signed-in two-factor step-up', () => {
		// Each account gets its own secret, so one account's code is not valid
		// for another.
		const secrets = ['JBSWY3DPEHPK3PXP', 'KRSXG5CTMVRXEZLU', 'MFRGGZDFMZTWQ2LK']
		let nextSecret = 0
		async function setupTwoFactor(userId: string) {
			const secret = secrets[nextSecret++ % secrets.length]!
			await db.insert(Verification).values({
				type: '2fa',
				target: userId,
				secret,
				algorithm: 'SHA-1',
				digits: 6,
				period: 30,
				charSet: '0123456789',
			})
			const { otp } = await generateTOTP({
				secret,
				algorithm: 'SHA-1',
				period: 30,
				digits: 6,
			})
			return otp
		}

		async function submit2fa(cookie: string, target: string, code: string) {
			const formData = new FormData()
			formData.append('type', '2fa')
			formData.append('target', target)
			formData.append('code', code)
			const request = createAuthenticatedRequest(
				'http://localhost:3000/verify',
				{ method: 'POST', body: formData },
				cookie,
			)
			try {
				return (await action({
					request,
					params: {},
					context: {},
				} as any)) as Response
			} catch (thrown) {
				return thrown as Response
			}
		}

		/** The auth-session cookie this response sets, if any. */
		async function authSessionFrom(response: Response) {
			const empty = await authSessionStorage.commitSession(
				await authSessionStorage.getSession(),
			)
			const name = empty.split('=')[0]
			const header = response.headers
				.getSetCookie()
				.find((value) => value.startsWith(`${name}=`))
			if (!header) return null
			return authSessionStorage.getSession(header.split(';')[0])
		}

		it("refuses another account's valid code for a signed-in session", async () => {
			const caller = await createTestUser()
			const other = await createTestUser()
			await setupTwoFactor(caller.id)
			const otherOtp = await setupTwoFactor(other.id)
			const { cookie } = await createTestSession(caller.id)

			const response = await submit2fa(cookie, other.id, otherOtp)

			expect(response.status).toBe(302)
			expect(response.headers.get('Location')).toContain('/login')
			// Nothing is stamped on the caller's session.
			expect(await authSessionFrom(response)).toBeNull()
		})

		it("refuses another account's code submitted for the signed-in user", async () => {
			const caller = await createTestUser()
			const other = await createTestUser()
			await setupTwoFactor(caller.id)
			const otherOtp = await setupTwoFactor(other.id)
			const { cookie } = await createTestSession(caller.id)

			const response = await submit2fa(cookie, caller.id, otherOtp)

			// The code does not verify for the caller: refused, nothing stamped.
			expect(getResponseStatus(response)).toBe(400)
		})

		it("accepts the signed-in user's own code", async () => {
			const caller = await createTestUser()
			const otp = await setupTwoFactor(caller.id)
			const { cookie } = await createTestSession(caller.id)

			const response = await submit2fa(cookie, caller.id, otp)

			expect(response.status).toBe(302)
			expect(response.headers.get('Location')).not.toContain('/login')
			const authSession = await authSessionFrom(response)
			const verifiedAt = authSession?.get('verified-time')
			expect(verifiedAt).toBeTypeOf('number')
			expect(Date.now() - verifiedAt).toBeLessThan(60_000)
		})
	})
})
