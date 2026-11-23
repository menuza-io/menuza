import { AuditAction } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { BackupCode, Verification, and, db, eq } from '@repo/database'
import { data, type ActionFunctionArgs } from 'react-router'
import {
	auditSupportAction,
	requireSensitiveSupportAction,
} from '#app/utils/support.server.ts'

/** The verification type of an enabled authenticator app (see the App's security page). */
export const TWO_FACTOR_VERIFICATION_TYPE = '2fa'

/**
 * Reset a user's two-factor sign-in: removes the authenticator and the backup
 * codes so they can sign in with their password and set it up again. Needs a
 * fresh caller verification, checked first on the server (#291).
 */
export async function action({ request, params }: ActionFunctionArgs) {
	const agentId = await requireUserWithRole(request, 'admin')
	const userId = params.userId
	if (!userId) throw data({ error: 'not_found' }, { status: 404 })
	await requireSensitiveSupportAction({
		request,
		agentId,
		userId,
		action: 'reset_two_factor',
	})

	const removed = await db
		.delete(Verification)
		.where(
			and(
				eq(Verification.type, TWO_FACTOR_VERIFICATION_TYPE),
				eq(Verification.target, userId),
			),
		)
		.returning({ id: Verification.id })
	await db.delete(BackupCode).where(eq(BackupCode.userId, userId))

	await auditSupportAction({
		action: AuditAction.ADMIN_USER_TWO_FACTOR_RESET,
		agentId,
		targetUserId: userId,
		resourceType: 'User',
		resourceId: userId,
		details: 'Reset two-factor sign-in',
		metadata: { hadTwoFactor: removed.length > 0 },
		request,
		severity: 'warning',
	})

	return redirectWithToast(`/users/${userId}`, {
		type: 'success',
		title: 'Two-factor sign-in reset',
		description: 'They can sign in with their password and set it up again.',
	})
}
