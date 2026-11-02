import type * as AuthModule from '@repo/auth'
import { verifySessionStorage } from '@repo/auth'
import type * as DatabaseModule from '@repo/database'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { resetMockDb } from '#tests/setup/drizzle-mock.ts'
import { action } from './auth.onboarding.ts'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	process.env.DATABASE_URL = 'file:./data.db'
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

vi.mock('@repo/auth', async (importOriginal) => {
	const actual = await importOriginal<typeof AuthModule>()
	return {
		...actual,
		verifySessionStorage: {
			getSession: vi.fn(),
		},
		checkIsCommonPassword: vi.fn().mockResolvedValue(false),
	}
})

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	const { mockDb, drizzleTable, drizzleOperator } =
		await import('#tests/setup/drizzle-mock.ts')
	return {
		...actual,
		db: mockDb,
		User: drizzleTable,
		eq: drizzleOperator,
	}
})

vi.mock('@repo/security', () => ({
	checkHoneypot: vi.fn().mockResolvedValue(undefined),
	assertSecretNotPlaceholder: (_name: string, value: string) => value,
}))

describe('auth.onboarding API action (WO-86 Email Session Binding)', () => {
	const mockGetSession = vi.mocked(verifySessionStorage.getSession)

	beforeEach(() => {
		resetMockDb()
	})

	it('rejects onboarding request when no verification session cookie is present (400)', async () => {
		mockGetSession.mockResolvedValue({
			get: () => undefined,
		} as any)

		const formData = new FormData()
		formData.append('email', 'attacker@example.com')
		formData.append('username', 'attacker123')
		formData.append('name', 'Attacker')
		formData.append('password', 'ValidPassword123!')
		formData.append('confirmPassword', 'ValidPassword123!')
		formData.append('agreeToTermsOfServiceAndPrivacyPolicy', 'true')

		const request = new Request('http://localhost:3000/api/auth/onboarding', {
			method: 'POST',
			body: formData,
		})

		const response = (await action({
			request,
			params: {},
			context: {},
		} as any)) as any
		const responseData = response.data ?? (await response.json())

		expect(response.status ?? 400).toBe(400)
		expect(responseData).toEqual({
			success: false,
			error: 'no_verification_session',
			message:
				'No verification session found. Please start the signup process again.',
		})
	})
})
