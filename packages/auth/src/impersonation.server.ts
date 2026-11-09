import { auditService, AuditAction } from '@repo/audit'
import {
	alias,
	db,
	eq,
	inArray,
	lte,
	User,
	ImpersonationSession,
} from '@repo/database'
import {
	impersonationSessionStorage,
	impersonationSessionKey,
	getImpersonationExpirationDate,
	getClientIp,
	hashIp,
} from './impersonation-session.server.ts'

export interface ImpersonationInfo {
	adminUserId: string
	adminName: string
	targetUserId: string
	targetName: string
	startedAt: string
	expiresAt: string
}

export interface ImpersonationValidationResult {
	valid: boolean
	info: ImpersonationInfo | null
	invalidReason?: 'not_found' | 'expired' | 'ip_mismatch'
}

const adminUser = alias(User, 'adminUser')
const targetUser = alias(User, 'targetUser')

async function getImpersonationSessionId(
	request: Request,
): Promise<string | null> {
	const session = await impersonationSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	return session.get(impersonationSessionKey) || null
}

export async function validateImpersonation(
	request: Request,
): Promise<ImpersonationValidationResult> {
	const sessionId = await getImpersonationSessionId(request)
	if (!sessionId) {
		return { valid: false, info: null }
	}

	const [impersonationSession] = await db
		.select({
			adminUserId: ImpersonationSession.adminUserId,
			targetUserId: ImpersonationSession.targetUserId,
			ipHash: ImpersonationSession.ipHash,
			createdAt: ImpersonationSession.createdAt,
			expiresAt: ImpersonationSession.expiresAt,
			adminName: adminUser.name,
			adminUsername: adminUser.username,
			targetName: targetUser.name,
			targetUsername: targetUser.username,
		})
		.from(ImpersonationSession)
		.innerJoin(adminUser, eq(ImpersonationSession.adminUserId, adminUser.id))
		.innerJoin(targetUser, eq(ImpersonationSession.targetUserId, targetUser.id))
		.where(eq(ImpersonationSession.id, sessionId))
		.limit(1)

	if (!impersonationSession) {
		return { valid: false, info: null, invalidReason: 'not_found' }
	}

	const now = new Date()
	if (impersonationSession.expiresAt <= now) {
		return { valid: false, info: null, invalidReason: 'expired' }
	}

	const clientIp = getClientIp(request)
	const clientIpHash = hashIp(clientIp)
	if (clientIpHash !== impersonationSession.ipHash) {
		return { valid: false, info: null, invalidReason: 'ip_mismatch' }
	}

	const info: ImpersonationInfo = {
		adminUserId: impersonationSession.adminUserId,
		adminName:
			impersonationSession.adminName || impersonationSession.adminUsername,
		targetUserId: impersonationSession.targetUserId,
		targetName:
			impersonationSession.targetName || impersonationSession.targetUsername,
		startedAt: impersonationSession.createdAt.toISOString(),
		expiresAt: impersonationSession.expiresAt.toISOString(),
	}

	return { valid: true, info }
}

export async function getImpersonationInfo(
	request: Request,
): Promise<ImpersonationInfo | null> {
	const result = await validateImpersonation(request)
	return result.info
}

export async function isImpersonating(request: Request): Promise<boolean> {
	const result = await validateImpersonation(request)
	return result.valid
}

export async function getEffectiveUserId(
	request: Request,
	originalUserId: string,
): Promise<{ userId: string; isImpersonating: boolean }> {
	const result = await validateImpersonation(request)
	if (result.valid && result.info) {
		return { userId: result.info.targetUserId, isImpersonating: true }
	}
	return { userId: originalUserId, isImpersonating: false }
}

export async function destroyImpersonationSession(
	request: Request,
): Promise<string> {
	const session = await impersonationSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	return impersonationSessionStorage.destroySession(session)
}

export async function deleteImpersonationSessionFromDb(
	sessionId: string,
): Promise<void> {
	await db
		.delete(ImpersonationSession)
		.where(eq(ImpersonationSession.id, sessionId))
		.catch(() => {})
}

export type ImpersonationEndReason = 'stopped' | 'expired' | 'replaced'

/**
 * Ends the impersonation sessions matching `where`: each session this call
 * deletes gets one ADMIN_IMPERSONATION_END entry with the reason (an expired
 * session swept up or replaced by a new one included). Rows are deleted first,
 * so two callers ending the same session (a stop click and the hourly cleanup)
 * log it once. Returns how many sessions were ended.
 */
export async function endImpersonationSessions({
	where,
	reason,
	request,
	now = new Date(),
}: {
	where: ReturnType<typeof eq> | undefined
	/** Used for sessions that have not expired; expired ones say `expired`. */
	reason: ImpersonationEndReason
	request?: Request
	now?: Date
}): Promise<number> {
	const sessions = await db
		.select({
			id: ImpersonationSession.id,
			adminUserId: ImpersonationSession.adminUserId,
			targetUserId: ImpersonationSession.targetUserId,
			createdAt: ImpersonationSession.createdAt,
			expiresAt: ImpersonationSession.expiresAt,
			targetName: targetUser.name,
			targetUsername: targetUser.username,
		})
		.from(ImpersonationSession)
		.innerJoin(targetUser, eq(ImpersonationSession.targetUserId, targetUser.id))
		.where(where)
	if (sessions.length === 0) return 0
	// Delete first and log only the sessions this call removed: a stop click
	// racing the hourly cleanup must log one end, not two.
	const deleted = await db
		.delete(ImpersonationSession)
		.where(
			inArray(
				ImpersonationSession.id,
				sessions.map((session) => session.id),
			),
		)
		.returning({ id: ImpersonationSession.id })
	const deletedIds = new Set(deleted.map((row) => row.id))
	for (const session of sessions) {
		if (!deletedIds.has(session.id)) continue
		const endReason = session.expiresAt <= now ? 'expired' : reason
		const targetName = session.targetName || session.targetUsername
		// Expired sessions end at their expiry, not when they are swept up.
		const endedAt = endReason === 'expired' ? session.expiresAt : now
		const duration = Math.max(
			0,
			endedAt.getTime() - session.createdAt.getTime(),
		)
		await auditService.logAdminOperation(
			AuditAction.ADMIN_IMPERSONATION_END,
			session.adminUserId,
			endReason === 'stopped'
				? `Stopped impersonating user: ${targetName}`
				: `Impersonation of user ${targetName} ended (${endReason})`,
			{
				adminId: session.adminUserId,
				targetUserId: session.targetUserId,
				targetName,
				duration,
				durationMinutes: Math.floor(duration / 1000 / 60),
				impersonationSessionId: session.id,
				reason: endReason,
			},
			request,
		)
	}
	return deleted.length
}

export async function cleanupExpiredImpersonationSessions(): Promise<number> {
	return endImpersonationSessions({
		where: lte(ImpersonationSession.expiresAt, new Date()),
		reason: 'expired',
	})
}

/** Another start for the same admin created its session first. */
export class ImpersonationStartConflictError extends Error {
	constructor() {
		super('Another impersonation start for this admin is in progress')
		this.name = 'ImpersonationStartConflictError'
	}
}

/**
 * Starts an impersonation for `adminUserId`, ending any earlier one (audited
 * END, reason `replaced` or `expired`). `ImpersonationSession.adminUserId` is
 * unique, so of two overlapping starts only one insert wins. The loser throws
 * `ImpersonationStartConflictError` instead of ending the winner's session,
 * so a session id handed to a caller is never one a concurrent start deleted.
 */
export async function startImpersonationSession({
	adminUserId,
	targetUserId,
	ipHash,
	request,
}: {
	adminUserId: string
	targetUserId: string
	ipHash: string
	request?: Request
}): Promise<{ id: string; expiresAt: Date }> {
	await endImpersonationSessions({
		where: eq(ImpersonationSession.adminUserId, adminUserId),
		reason: 'replaced',
		request,
	})
	const [created] = await db
		.insert(ImpersonationSession)
		.values({
			adminUserId,
			targetUserId,
			expiresAt: getImpersonationExpirationDate(),
			ipHash,
		})
		.onConflictDoNothing({ target: ImpersonationSession.adminUserId })
		.returning({
			id: ImpersonationSession.id,
			expiresAt: ImpersonationSession.expiresAt,
		})
	if (!created) throw new ImpersonationStartConflictError()
	return created
}
