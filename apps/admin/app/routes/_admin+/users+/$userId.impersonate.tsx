import { invariantResponse } from '@epic-web/invariant'
import { auditService, AuditAction } from '@repo/audit'
import {
	requireUserWithRole,
	impersonationSessionStorage,
	impersonationSessionKey,
	getImpersonationExpirationDate,
	getClientIp,
	hashIp,
	IMPERSONATION_COOKIE_MAX_AGE,
} from '@repo/auth'
import { getOperatorAppUrl } from '@repo/common/cookie-domain'
import { createToastHeaders } from '@repo/common/toast'
import { ImpersonationSession, User, db, eq } from '@repo/database'
import { data, redirect } from 'react-router'
import { ENV } from 'varlock/env'

export async function action({
	request,
	params,
}: {
	request: Request
	params: { userId: string }
}) {
	const adminUserId = await requireUserWithRole(request, 'admin')
	const { userId } = params
	invariantResponse(userId, 'User ID is required')

	// Get the target user to impersonate
	const [targetUser] = await db
		.select({
			id: User.id,
			name: User.name,
			username: User.username,
			email: User.email,
			isBanned: User.isBanned,
			banExpiresAt: User.banExpiresAt,
		})
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)

	invariantResponse(targetUser, 'User not found', { status: 404 })

	// Check if user is banned and ban hasn't expired
	if (targetUser.isBanned) {
		const now = new Date()
		const banExpired =
			targetUser.banExpiresAt && new Date(targetUser.banExpiresAt) <= now

		if (!banExpired) {
			throw data(
				{ error: 'Cannot impersonate banned user' },
				{
					status: 400,
					headers: await createToastHeaders({
						type: 'error',
						title: 'Impersonation Failed',
						description: 'Cannot impersonate a banned user.',
					}),
				},
			)
		}
	}

	// Get admin user info for audit logging
	const [adminUser] = await db
		.select({ id: User.id, name: User.name, username: User.username })
		.from(User)
		.where(eq(User.id, adminUserId))
		.limit(1)

	invariantResponse(adminUser, 'Admin user not found')

	// Get client IP and create hash for binding
	const clientIp = getClientIp(request)
	const ipHash = hashIp(clientIp)

	// Delete any existing impersonation sessions for this admin
	await db
		.delete(ImpersonationSession)
		.where(eq(ImpersonationSession.adminUserId, adminUserId))

	// Create a new impersonation session with 15-minute TTL and IP binding
	const [impersonationSession] = await db
		.insert(ImpersonationSession)
		.values({
			adminUserId,
			targetUserId: targetUser.id,
			expiresAt: getImpersonationExpirationDate(),
			ipHash,
		})
		.returning({
			id: ImpersonationSession.id,
			expiresAt: ImpersonationSession.expiresAt,
		})
	if (!impersonationSession)
		throw new Error('Could not create impersonation session')

	// Log the impersonation start using the audit service
	await auditService.logAdminOperation(
		AuditAction.ADMIN_IMPERSONATION_START,
		adminUserId,
		`Started impersonating user: ${targetUser.name || targetUser.username} (${targetUser.email})`,
		{
			adminId: adminUserId,
			adminName: adminUser.name || adminUser.username,
			targetUserId: targetUser.id,
			targetName: targetUser.name || targetUser.username,
			targetEmail: targetUser.email,
			impersonationSessionId: impersonationSession.id,
			expiresAt: impersonationSession.expiresAt.toISOString(),
			ipBound: true,
		},
		request,
	)

	// Create impersonation cookie session (separate from auth session)
	const impSession = await impersonationSessionStorage.getSession()
	impSession.set(impersonationSessionKey, impersonationSession.id)

	// Redirect to main app as the impersonated user (separate origin from admin)
	const appUrl = getOperatorAppUrl(ENV.BASE_URL, ENV.ROOT_APP)
	throw redirect(`${appUrl}/`, {
		headers: {
			'set-cookie': await impersonationSessionStorage.commitSession(
				impSession,
				{ maxAge: IMPERSONATION_COOKIE_MAX_AGE },
			),
			...(await createToastHeaders({
				type: 'success',
				title: 'Impersonation Started',
				description: `Now impersonating ${targetUser.name || targetUser.username}. Session expires in 15 minutes.`,
			})),
		},
	})
}
