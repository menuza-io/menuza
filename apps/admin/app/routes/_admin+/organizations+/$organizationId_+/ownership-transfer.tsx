import { AuditAction } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { UserOrganization, and, db, eq } from '@repo/database'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	auditSupportAction,
	requireSensitiveSupportAction,
} from '#app/utils/support.server.ts'

/** The organization admin role: the people who run a restaurant's account. */
export const ORG_ADMIN_ROLE_ID = 'org_role_admin'

const TransferSchema = z.object({
	/** The caller who asked for the transfer: must be an admin of the organization. */
	fromUserId: z.string().trim().min(1).max(64),
	/** The member who becomes an admin. */
	toUserId: z.string().trim().min(1).max(64),
})

/**
 * Start an ownership transfer: the member the caller names becomes an admin of
 * the organization. The caller stays an admin until the restaurant removes
 * them, so nobody is locked out mid-way. It needs a fresh verification of the
 * CALLER (the current admin who is asking), checked first on the server, so a
 * stranger who only knows the new owner's name cannot start one (#291).
 */
export async function action({ request, params }: ActionFunctionArgs) {
	const agentId = await requireUserWithRole(request, 'admin')
	const organizationId = params.organizationId
	if (!organizationId) throw data({ error: 'not_found' }, { status: 404 })

	// The caller's id is read before the gate only to know whom to check; nothing
	// is changed until the verification has passed.
	const form = Object.fromEntries(await request.formData())
	const parsed = TransferSchema.safeParse(form)
	if (!parsed.success) return data({ error: 'invalid_form' }, { status: 400 })
	const { fromUserId, toUserId } = parsed.data

	await requireSensitiveSupportAction({
		request,
		agentId,
		userId: fromUserId,
		action: 'start_ownership_transfer',
		organizationId,
	})

	const members = await db
		.select({
			userId: UserOrganization.userId,
			roleId: UserOrganization.organizationRoleId,
			active: UserOrganization.active,
		})
		.from(UserOrganization)
		.where(eq(UserOrganization.organizationId, organizationId))
	const from = members.find((member) => member.userId === fromUserId)
	const to = members.find((member) => member.userId === toUserId)
	if (!from?.active || from.roleId !== ORG_ADMIN_ROLE_ID) {
		return data({ error: 'caller_not_admin' }, { status: 400 })
	}
	if (!to?.active) return data({ error: 'target_not_member' }, { status: 400 })
	if (to.roleId === ORG_ADMIN_ROLE_ID) {
		return data({ error: 'already_admin' }, { status: 409 })
	}

	await db
		.update(UserOrganization)
		.set({ organizationRoleId: ORG_ADMIN_ROLE_ID })
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.userId, toUserId),
			),
		)

	await auditSupportAction({
		action: AuditAction.ADMIN_OWNERSHIP_TRANSFER_STARTED,
		agentId,
		organizationId,
		targetUserId: toUserId,
		resourceType: 'Organization',
		resourceId: organizationId,
		details: 'Started an ownership transfer',
		metadata: { fromUserId, toUserId },
		request,
		severity: 'warning',
	})

	return redirectWithToast(`/organizations/${organizationId}`, {
		type: 'success',
		title: 'Ownership transfer started',
		description:
			'The new admin has access. The caller stays an admin until removed.',
	})
}
