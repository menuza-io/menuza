import { authSessionStorage, sessionKey } from '@repo/auth'
import { and, db, eq, gt, Session, User } from '@repo/database'

/**
 * Whether the request carries a signed operator session cookie for a session
 * that exists, has not expired, and belongs to a user who is not banned.
 *
 * Used where a yes/no is enough and nothing may be thrown or written: the
 * Worker's gate on private client code (`/assets/app/*`, `/__manifest`) and the
 * document's route manifest. Route loaders keep using `requireUserId`, which
 * also handles impersonation, ban expiry and cookie cleanup.
 *
 * One page load fetches many private chunks, so a positive answer is cached
 * per isolate for a short time. A logged-out or revoked session can keep
 * downloading UI code for at most {@link POSITIVE_CACHE_MS}; it never reaches
 * data, which every loader checks on its own.
 */
export async function hasActiveSession(request: Request): Promise<boolean> {
	return (await sessionStatus(request)) === 'active'
}

/**
 * Like {@link hasActiveSession}, but tells a failed database lookup
 * (`unavailable`) apart from no session (`none`), for callers that would
 * otherwise send a signed-in user to the login page during an outage.
 */
export async function sessionStatus(
	request: Request,
): Promise<'active' | 'none' | 'unavailable'> {
	const cookie = request.headers.get('cookie')
	if (!cookie) return 'none'

	let sessionId: unknown
	try {
		const session = await authSessionStorage.getSession(cookie)
		sessionId = session.get(sessionKey)
	} catch {
		return 'none'
	}
	if (typeof sessionId !== 'string' || !sessionId) return 'none'

	const now = Date.now()
	const cachedAt = positiveCache.get(sessionId)
	if (cachedAt !== undefined && now - cachedAt < POSITIVE_CACHE_MS)
		return 'active'

	try {
		const [row] = await db
			.select({
				isBanned: User.isBanned,
				banExpiresAt: User.banExpiresAt,
			})
			.from(Session)
			.innerJoin(User, eq(Session.userId, User.id))
			.where(
				and(eq(Session.id, sessionId), gt(Session.expirationDate, new Date())),
			)
			.limit(1)
		if (!row) return 'none'
		const banned =
			row.isBanned &&
			!(row.banExpiresAt && new Date(row.banExpiresAt).getTime() <= now)
		if (banned) return 'none'
	} catch {
		// Fail closed: without the database nothing behind the gate works anyway.
		return 'unavailable'
	}

	if (positiveCache.size >= MAX_CACHE_ENTRIES) {
		const oldest = positiveCache.keys().next().value
		if (oldest !== undefined) positiveCache.delete(oldest)
	}
	positiveCache.set(sessionId, now)
	return 'active'
}

export const POSITIVE_CACHE_MS = 30_000
const MAX_CACHE_ENTRIES = 1_000
const positiveCache = new Map<string, number>()

/** Test helper. */
export function clearSessionGateCache() {
	positiveCache.clear()
}
