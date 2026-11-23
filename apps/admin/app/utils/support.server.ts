import { AuditAction, auditService } from '@repo/audit'
import { requireFreshCallerVerification } from '@repo/auth'
import {
	type SensitiveSupportAction,
	SENSITIVE_ACTION_LABELS,
} from '@repo/common/support-verification'
import { User, db, eq } from '@repo/database'

/** The support member's name for audit rows and the timeline: name, else username. */
export async function getAgentName(agentId: string): Promise<string> {
	const [agent] = await db
		.select({ name: User.name, username: User.username })
		.from(User)
		.where(eq(User.id, agentId))
		.limit(1)
	return agent?.name?.trim() || agent?.username || agentId
}

/**
 * One audit row for a support action. Every one carries the support member's
 * name (`agentName`) next to their id. Metadata holds ids, states and names of
 * support staff: never a sign-in code, a message or a guest.
 */
export async function auditSupportAction(input: {
	action: AuditAction
	agentId: string
	details: string
	metadata?: Record<string, unknown>
	organizationId?: string | null
	targetUserId?: string
	resourceType?: string
	resourceId?: string
	request?: Request
	severity?: 'info' | 'warning'
}) {
	const agentName = await getAgentName(input.agentId)
	await auditService.log({
		action: input.action,
		userId: input.agentId,
		organizationId: input.organizationId ?? null,
		targetUserId: input.targetUserId,
		resourceType: input.resourceType,
		resourceId: input.resourceId,
		details: input.details,
		metadata: { agentName, ...input.metadata },
		request: input.request,
		severity: input.severity ?? 'info',
	})
	return agentName
}

/**
 * The gate of the sensitive support actions (#291): change email, reset
 * two-factor sign-in and start an ownership transfer. It runs first in the
 * action, on the server, before the form is read. Without a verification of
 * the affected user by this agent from the last 15 minutes it audits the
 * refusal and throws a 403.
 */
export async function requireSensitiveSupportAction(input: {
	request: Request
	agentId: string
	userId: string
	action: SensitiveSupportAction
	organizationId?: string | null
}) {
	try {
		return await requireFreshCallerVerification({
			agentId: input.agentId,
			userId: input.userId,
		})
	} catch (thrown) {
		if (thrown instanceof Response && thrown.status === 403) {
			await auditSupportAction({
				action: AuditAction.ADMIN_SUPPORT_ACTION_REFUSED,
				agentId: input.agentId,
				organizationId: input.organizationId,
				targetUserId: input.userId,
				details: `${SENSITIVE_ACTION_LABELS[input.action]} refused: no verification from the last 15 minutes`,
				metadata: { sensitiveAction: input.action },
				request: input.request,
				severity: 'warning',
			})
		}
		throw thrown
	}
}
