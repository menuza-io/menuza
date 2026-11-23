import { AuditAction, auditService } from '@repo/audit'
import { requireUserId, revealVerificationCode } from '@repo/auth'
import { type ActionFunctionArgs } from 'react-router'
import { refuseWhileImpersonating } from '#app/utils/impersonation-guard.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	SUPPORT_VERIFICATION_REVEAL_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * `POST /resources/support-verification`: the signed-in operator opens the
 * "Menuza support asked to confirm it's you" card and the 6-digit code is made
 * and returned, once, to this session (#291). Never while an admin is
 * impersonating the user: the agent who asked must not be able to read the code
 * through the impersonated session. The code is not logged; the audit row
 * records only that a code was shown.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	const userId = await requireUserId(request)
	await refuseWhileImpersonating(
		request,
		'Stop impersonating: the code is only for the signed-in person',
	)

	const limit = await checkRateLimit(
		{ type: 'user', value: userId },
		SUPPORT_VERIFICATION_REVEAL_RATE_LIMIT,
	)
	if (!limit.allowed) return createRateLimitResponse(limit.resetAt)

	const form = await request.formData()
	const verificationId = String(form.get('verificationId') ?? '')
	if (!verificationId || verificationId.length > 64) {
		return Response.json(
			{ status: 'not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}

	const result = await revealVerificationCode({ userId, verificationId })
	if (result.status !== 'ok') {
		return Response.json(
			{
				status: result.status,
				...(result.status === 'locked' && {
					lockedUntil: result.lockedUntil.toISOString(),
				}),
			},
			{ status: result.status === 'not_found' ? 404 : 409, headers: NO_STORE },
		)
	}

	await auditService.log({
		action: AuditAction.CALLER_VERIFICATION_CODE_SHOWN,
		userId,
		targetUserId: userId,
		resourceType: 'SupportVerification',
		resourceId: verificationId,
		details: 'A support verification code was shown to the signed-in user',
		request,
	})

	return Response.json(
		{
			status: 'ok',
			code: result.code,
			expiresAt: result.expiresAt.toISOString(),
		},
		{ headers: NO_STORE },
	)
}
