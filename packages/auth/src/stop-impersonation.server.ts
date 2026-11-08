import { combineHeaders } from '@repo/common'
import { createToastHeaders } from '@repo/common/toast'
import { ImpersonationSession, db, eq } from '@repo/database'
import { data, redirect } from 'react-router'

import {
	destroyImpersonationSession,
	endImpersonationSessions,
} from './impersonation.server.ts'
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

	const targetName =
		impersonationSession.targetUser.name ||
		impersonationSession.targetUser.username

	// Audited before the row goes, with `expired` when the session had already
	// run out.
	await endImpersonationSessions({
		where: eq(ImpersonationSession.id, impersonationSessionId),
		reason: 'stopped',
		request,
	})

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
