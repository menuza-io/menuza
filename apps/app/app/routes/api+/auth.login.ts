import { parseWithZod } from '@conform-to/zod/v4'
import { auditService, AuditAction } from '@repo/audit'
import { and, db, eq, Verification } from '@repo/database'
import { checkHoneypot } from '@repo/security'
import { UsernameSchema, PasswordSchema } from '@repo/validation'
import { data } from 'react-router'
import { z } from 'zod'
import { login } from '#app/utils/auth.server.ts'
import {
	createAuthenticatedSessionResponse,
	create2FAToken,
} from '#app/utils/jwt.server.ts'
import { checkSSOEnforcementByIdentifier } from '#app/utils/sso/enforcement.server.ts'
import { type Route } from './+types/auth.login.ts'

const LoginFormSchema = z.object({
	username: UsernameSchema,
	password: PasswordSchema,
	redirectTo: z.string().optional(),
	remember: z
		.union([z.boolean(), z.string()])
		.optional()
		.transform((val) => {
			if (typeof val === 'string') {
				return val === 'on' || val === 'true'
			}
			return Boolean(val)
		}),
})

// This endpoint is protected by the server-level rate limiter (10
// requests/min for paths including /login - see apps/app/server/index.ts).

export async function action({ request }: Route.ActionArgs) {
	const formData = await request.formData()
	await checkHoneypot(formData)

	const submission = await parseWithZod(formData, {
		schema: LoginFormSchema.transform(async (data, ctx) => {
			// Password login is not allowed for members of an SSO-enforced org.
			const ssoEnforcement = await checkSSOEnforcementByIdentifier(
				data.username,
			)
			if (ssoEnforcement.enforced) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Your organization requires SSO login',
				})
				return z.NEVER
			}
			const session = await login({ ...data, request })
			if (!session) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Invalid username or password',
				})
				return z.NEVER
			}
			return { ...data, session }
		}),
		async: true,
	})

	if (submission.status !== 'success' || !submission.value.session) {
		// Log failed login attempt (SOC 2 CC7.2)
		const username = formData.get('username')?.toString()
		void auditService.logAuth(
			AuditAction.USER_LOGIN_FAILED,
			undefined,
			`Failed API login attempt for: ${username}`,
			{ username, source: 'api' },
			request,
			false,
		)

		return data(
			{
				success: false,
				error: 'authentication_failed',
				message: 'Invalid username or password',
			},
			{ status: 400 },
		)
	}

	const { session } = submission.value

	// Check if user has 2FA enrolled
	const [twoFactorVerification] = await db
		.select()
		.from(Verification)
		.where(
			and(
				eq(Verification.target, session.userId),
				eq(Verification.type, '2fa'),
			),
		)
		.limit(1)

	if (twoFactorVerification) {
		const loginToken = create2FAToken(session.userId, session.id)
		return data(
			{
				success: false,
				error: 'two_factor_required',
				message: 'Two-factor authentication required',
				userId: session.userId,
				loginToken,
			},
			{ status: 400 },
		)
	}

	// Log successful login (SOC 2 CC7.2)
	void auditService.logAuth(
		AuditAction.USER_LOGIN,
		session.userId,
		'User logged in via API',
		{ source: 'api', loginMethod: 'password' },
		request,
		true,
	)

	// Use shared helper to create authenticated session response
	const response = await createAuthenticatedSessionResponse(
		session.userId,
		request,
	)

	if (!response.success) {
		return data(response, { status: 400 })
	}

	return data(response)
}
