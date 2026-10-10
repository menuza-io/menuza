import { parseWithZod } from '@conform-to/zod'
import { auditService, AuditAction } from '@repo/audit'
import { db, eq, User } from '@repo/database'
import { checkHoneypot } from '@repo/security'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { isCodeValid } from '#app/routes/_auth+/verify.server.tsx'
import {
	createAuthenticatedSessionResponse,
	verify2FAToken,
} from '#app/utils/jwt.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	VERIFICATION_CODE_ATTEMPT_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'

const Login2FASchema = z.object({
	userId: z.string(),
	loginToken: z.string().min(1, 'loginToken is required'),
	code: z.string().min(1, '2FA code is required'),
})

// This endpoint is protected by the server-level rate limiter (10
// requests/min for paths including /login - see apps/app/server/index.ts).

export async function action({ request }: ActionFunctionArgs) {
	try {
		const formData = await request.formData()
		try {
			await checkHoneypot(formData)
		} catch {
			return data(
				{
					success: false,
					error: 'spam_detected',
					message: 'Form submission failed security check',
				},
				{ status: 400 },
			)
		}

		const submission = await parseWithZod(formData, {
			schema: Login2FASchema,
		})

		if (submission.status !== 'success') {
			return data(
				{
					success: false,
					error: 'validation_failed',
					message: 'Missing required fields',
				},
				{ status: 400 },
			)
		}

		const { userId, code, loginToken } = submission.value

		// Verify the login token matches the user ID
		const decoded = verify2FAToken(loginToken)
		if (!decoded || decoded.userId !== userId) {
			return data(
				{
					success: false,
					error: 'access_denied',
					message: 'Invalid or expired login session',
				},
				{ status: 403 },
			)
		}

		// The per-IP limiter alone lets a distributed attacker keep guessing the
		// 6-digit code for the 5 minutes the login token lives; cap per account.
		const attempts = await checkRateLimit(
			// Same key shape as validateRequest in _auth+/verify.server.tsx so the
			// web and API 2FA paths draw from one budget per account.
			{ type: 'token', value: `2fa:${userId.toLowerCase()}`.slice(0, 320) },
			VERIFICATION_CODE_ATTEMPT_RATE_LIMIT,
		)
		if (!attempts.allowed) return createRateLimitResponse(attempts.resetAt)

		const [user] = await db
			.select({ id: User.id })
			.from(User)
			.where(eq(User.id, userId))
			.limit(1)

		if (!user) {
			return data(
				{
					success: false,
					error: 'user_not_found',
					message: 'Invalid user',
				},
				{ status: 400 },
			)
		}

		const valid = await isCodeValid({
			code,
			type: '2fa',
			target: userId,
		})

		if (!valid) {
			void auditService.logAuth(
				AuditAction.USER_LOGIN_FAILED,
				userId,
				'Failed 2FA code verification for API login',
				{ source: 'api', hasTwoFactor: true },
				request,
				false,
			)

			return data(
				{
					success: false,
					error: 'invalid_code',
					message: 'Invalid or expired 2FA code',
				},
				{ status: 400 },
			)
		}

		void auditService.logAuth(
			AuditAction.USER_LOGIN,
			userId,
			'User logged in via API with 2FA',
			{ source: 'api', loginMethod: '2fa' },
			request,
			true,
		)

		const response = await createAuthenticatedSessionResponse(userId, request)

		if (!response.success) {
			return data(response, { status: 400 })
		}

		return data(response)
	} catch (error) {
		console.error('2FA login action error:', error)
		return data(
			{
				success: false,
				error: 'internal_error',
				message: 'An unexpected error occurred. Please try again.',
			},
			{ status: 500 },
		)
	}
}

export async function loader() {
	return data(
		{
			success: false,
			error: 'method_not_allowed',
			message: 'Use POST method for 2FA login verification',
		},
		{ status: 405 },
	)
}
