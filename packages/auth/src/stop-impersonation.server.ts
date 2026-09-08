import { auditService, AuditAction } from '@repo/audit'
import { combineHeaders } from '@repo/common'
import { createToastHeaders } from '@repo/common/toast'
import { ImpersonationSession, db, eq } from '@repo/database'
import { data, redirect } from 'react-router'

import { destroyImpersonationSession } from './impersonation.server.ts'
import {
	impersonationSessionKey,
	impersonationSessionStorage,
} from './impersonation-session.server.ts'

/**
 * Ends the active impersonation session and redirects.
 * Used by both App and Admin stop-impersonation routes.
 */
export async function stopImpersonation(
	request: Request,
	redirectTo: string,
): Promise<never> {
	const impSession = await impersonationSessionStorage.getSession(
		request.headers.get('cookie'),
	)

	const impersonationSessionId = impSession.get(impersonationSessionKey)

	if (!impersonationSessionId) {
		throw data(
			{ error: 'Not currently impersonating' },
			{
				status: 400,
				headers: await createToastHeaders({
					type: 'error',
					title: 'Error',
					description: 'Not currently impersonating a user.',
				}),
			},
		)
	}

	const impersonationSession = await db.query.ImpersonationSession.findFirst({
		where: eq(ImpersonationSession.id, impersonationSessionId),
		with: { adminUser: true, targetUser: true },
	})

	if (!impersonationSession) {
		throw redirect(redirectTo, {
			headers: combineHeaders(
				{ 'set-cookie': await destroyImpersonationSession(request) },
				await createToastHeaders({
					type: 'message',
					title: 'Session Expired',
					description: 'Impersonation session had already expired.',
				}),
			),
		})
	}

	const adminUserId = impersonationSession.adminUserId
	const targetUserId = impersonationSession.targetUserId
	const targetName =
		impersonationSession.targetUser.name ||
		impersonationSession.targetUser.username
	const duration = Date.now() - impersonationSession.createdAt.getTime()

	await db
		.delete(ImpersonationSession)
		.where(eq(ImpersonationSession.id, impersonationSessionId))

	const durationMinutes = Math.floor(duration / 1000 / 60)

	await auditService.logAdminOperation(
		AuditAction.ADMIN_IMPERSONATION_END,
		adminUserId,
		`Stopped impersonating user: ${targetName}`,
		{
			adminId: adminUserId,
			targetUserId,
			targetName,
			duration,
			durationMinutes,
			impersonationSessionId,
		},
		request,
	)

	throw redirect(redirectTo, {
		headers: combineHeaders(
			{ 'set-cookie': await destroyImpersonationSession(request) },
			await createToastHeaders({
				type: 'success',
				title: 'Impersonation Ended',
				description: `Stopped impersonating ${targetName}`,
			}),
		),
	})
}
