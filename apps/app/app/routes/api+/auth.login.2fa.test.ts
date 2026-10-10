import type * as DatabaseModule from '@repo/database'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { isCodeValid } from '#app/routes/_auth+/verify.server.tsx'
import {
	createAuthenticatedSessionResponse,
	verify2FAToken,
} from '#app/utils/jwt.server.ts'
import { mockSelectResults, resetMockDb } from '#tests/setup/drizzle-mock.ts'
import { action } from './auth.login.2fa.ts'

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
}))

vi.mock('@repo/audit', () => ({
	auditService: {
		logAuth: vi.fn().mockResolvedValue(undefined),
	},
	AuditAction: {
		USER_LOGIN: 'USER_LOGIN',
		USER_LOGIN_FAILED: 'USER_LOGIN_FAILED',
	},
}))

vi.mock('#app/routes/_auth+/verify.server.tsx', () => ({
	isCodeValid: vi.fn(),
}))

vi.mock('#app/utils/rate-limit.server.ts', () => ({
	checkRateLimit: vi
		.fn()
		.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() }),
	createRateLimitResponse: vi.fn(),
	VERIFICATION_CODE_ATTEMPT_RATE_LIMIT: {
		scope: 'verification-code-attempts',
		maxRequests: 10,
		windowMs: 900000,
	},
}))

vi.mock('#app/utils/jwt.server.ts', () => ({
	createAuthenticatedSessionResponse: vi.fn(),
	verify2FAToken: vi.fn(),
}))

describe('auth.login.2fa API action (WO-82)', () => {
	const mockIsCodeValid = vi.mocked(isCodeValid)
	const mockCreateSession = vi.mocked(createAuthenticatedSessionResponse)

	beforeEach(() => {
		resetMockDb()
		mockSelectResults([{ id: 'user-123' }])
	})

	it('returns error when 2FA code is invalid or expired (400)', async () => {
		const mockVerify2FAToken = vi.mocked(verify2FAToken)
		mockVerify2FAToken.mockReturnValue({
			userId: 'user-123',
			sessionId: 'session-123',
		})
		mockIsCodeValid.mockResolvedValue(false)

		const formData = new FormData()
		formData.append('userId', 'user-123')
		formData.append('code', '999999')
		formData.append('loginToken', 'valid-login-token')

		const request = new Request('http://localhost:3000/api/auth/login/2fa', {
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
			error: 'invalid_code',
			message: 'Invalid or expired 2FA code',
		})
		expect(mockCreateSession).not.toHaveBeenCalled()
	})

	it('completes 2FA login and returns session tokens when code is valid (200)', async () => {
		const mockVerify2FAToken = vi.mocked(verify2FAToken)
		mockVerify2FAToken.mockReturnValue({
			userId: 'user-123',
			sessionId: 'session-123',
		})
		mockIsCodeValid.mockResolvedValue(true)
		mockCreateSession.mockResolvedValue({
			success: true,
			data: {
				user: { id: 'user-123', email: 'test@example.com' },
				accessToken: 'access-token',
				refreshToken: 'refresh-token',
			},
		} as any)

		const formData = new FormData()
		formData.append('userId', 'user-123')
		formData.append('code', '123456')
		formData.append('loginToken', 'valid-login-token')

		const request = new Request('http://localhost:3000/api/auth/login/2fa', {
			method: 'POST',
			body: formData,
		})

		const response = (await action({
			request,
			params: {},
			context: {},
		} as any)) as any
		const responseData = response.data ?? (await response.json())

		expect(responseData.success).toBe(true)
		expect(responseData.data.accessToken).toBe('access-token')
		expect(mockCreateSession).toHaveBeenCalledWith('user-123', request)
	})
})
