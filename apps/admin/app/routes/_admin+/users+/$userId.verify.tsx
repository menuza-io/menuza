import { AuditAction } from '@repo/audit'
import {
	getVerificationLock,
	requestCallerVerification,
	requireUserWithRole,
	submitCallerVerificationCode,
} from '@repo/auth'
import {
	OrganizationRole,
	User,
	UserOrganization,
	Organization,
	and,
	db,
	eq,
} from '@repo/database'
import { data, type ActionFunctionArgs } from 'react-router'
import { auditSupportAction } from '#app/utils/support.server.ts'

/**
 * Verify caller (#291). `request` asks the signed-in operator to read out a
 * 6-digit code; `submit` checks what the agent typed. The code is never in a
 * response from here: Admin only learns whether it matched. Every request and
 * result is audited with the agent's name.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	const agentId = await requireUserWithRole(request, 'admin')
	const userId = params.userId
	if (!userId) throw data({ error: 'not_found' }, { status: 404 })

	const [target] = await db
		.select({ id: User.id })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	if (!target) throw data({ error: 'not_found' }, { status: 404 })

	const form = await request.formData()
	const intent = form.get('intent')

	if (intent === 'request') {
		const result = await requestCallerVerification({ agentId, userId })
		await auditSupportAction({
			action: AuditAction.CALLER_VERIFICATION_REQUESTED,
			agentId,
			targetUserId: userId,
			resourceType: 'SupportVerification',
			resourceId: result.status === 'requested' ? result.id : undefined,
			details: `Asked to verify the caller (${result.status})`,
			metadata: { outcome: result.status },
			request,
		})
		if (result.status === 'requested') {
			return data({
				status: 'requested' as const,
				expiresAt: result.expiresAt.toISOString(),
			})
		}
		if (result.status === 'locked') {
			return data(
				{
					status: 'locked' as const,
					lockedUntil: result.lockedUntil.toISOString(),
				},
				{ status: 429 },
			)
		}
		return data({ status: 'too_many' as const }, { status: 429 })
	}

	if (intent === 'submit') {
		const result = await submitCallerVerificationCode({
			agentId,
			userId,
			code: form.get('code'),
		})
		await auditSupportAction({
			action: AuditAction.CALLER_VERIFICATION_RESULT,
			agentId,
			targetUserId: userId,
			resourceType: 'SupportVerification',
			resourceId:
				result.status === 'verified' ? result.verificationId : undefined,
			details: `Caller verification result: ${result.status}`,
			metadata: {
				outcome: result.status,
				...(result.status === 'wrong' && { attemptsLeft: result.attemptsLeft }),
				...(result.status === 'locked' && {
					lockedUntil: result.lockedUntil.toISOString(),
				}),
			},
			request,
			severity:
				result.status === 'locked' || result.status === 'wrong'
					? 'warning'
					: 'info',
		})
		if (result.status === 'verified') {
			const memberships = await db
				.select({
					organizationId: Organization.id,
					organization: Organization.name,
					role: OrganizationRole.name,
				})
				.from(UserOrganization)
				.innerJoin(
					Organization,
					eq(Organization.id, UserOrganization.organizationId),
				)
				.innerJoin(
					OrganizationRole,
					eq(OrganizationRole.id, UserOrganization.organizationRoleId),
				)
				.where(
					and(
						eq(UserOrganization.userId, userId),
						eq(UserOrganization.active, true),
					),
				)
			return data({
				status: 'verified' as const,
				memberships,
			})
		}
		const lock = await getVerificationLock(userId)
		return data(
			{
				status: result.status,
				...(result.status === 'wrong' && { attemptsLeft: result.attemptsLeft }),
				...(lock && { lockedUntil: lock.toISOString() }),
			},
			{ status: result.status === 'locked' ? 429 : 400 },
		)
	}

	throw data({ error: 'invalid_intent' }, { status: 400 })
}
