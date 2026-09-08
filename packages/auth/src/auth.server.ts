import crypto from 'node:crypto'
import { combineHeaders } from '@repo/common'
import { shouldApplyImpersonationToUserId } from '@repo/common/cookie-domain'
import { and, db, eq, gt, Password, Session, User } from '@repo/database'
import {
	type Password as PasswordRow,
	type User as UserRow,
} from '@repo/database/types'
import bcrypt from 'bcryptjs'
import { redirect } from 'react-router'
import { safeRedirect } from 'remix-utils/safe-redirect'
import { validateImpersonation } from './impersonation.server.js'
import { authSessionStorage } from './session.server.js'

export const SESSION_EXPIRATION_TIME = 1000 * 60 * 60 * 24 * 30
export const getSessionExpirationDate = () =>
	new Date(Date.now() + SESSION_EXPIRATION_TIME)

export const sessionKey = 'sessionId'

function userWhere(
	where:
		Pick<UserRow, 'username'> | Pick<UserRow, 'id'> | Pick<UserRow, 'email'>,
) {
	if ('id' in where) return eq(User.id, where.id)
	if ('username' in where) return eq(User.username, where.username)
	return eq(User.email, where.email)
}

export async function getUserId(request: Request) {
	const sessionUserId = await getSessionUserId(request)
	if (!sessionUserId) return null

	if (shouldApplyImpersonationToUserId(request)) {
		const result = await validateImpersonation(request)
		if (
			result.valid &&
			result.info &&
			result.info.adminUserId === sessionUserId
		) {
			return result.info.targetUserId
		}
	}

	return sessionUserId
}

/** Session user from the auth cookie (never the impersonation target). */
export async function getSessionUserId(request: Request) {
	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const sessionId = authSession.get(sessionKey)
	if (!sessionId) return null
	const [session] = await db
		.select({
			userId: Session.userId,
			isBanned: User.isBanned,
			banExpiresAt: User.banExpiresAt,
		})
		.from(Session)
		.innerJoin(User, eq(Session.userId, User.id))
		.where(
			and(eq(Session.id, sessionId), gt(Session.expirationDate, new Date())),
		)
		.limit(1)
	if (!session?.userId) {
		throw redirect('/login', {
			headers: {
				'set-cookie': await authSessionStorage.destroySession(authSession),
			},
		})
	}

	if (session.isBanned) {
		const now = new Date()
		const banExpired =
			session.banExpiresAt && new Date(session.banExpiresAt) <= now

		if (banExpired) {
			await db
				.update(User)
				.set({
					isBanned: false,
					banReason: null,
					banExpiresAt: null,
					bannedAt: null,
					bannedById: null,
				})
				.where(eq(User.id, session.userId))
		} else {
			await db.delete(Session).where(eq(Session.userId, session.userId))
			throw redirect('/login?banned=true', {
				headers: {
					'set-cookie': await authSessionStorage.destroySession(authSession),
				},
			})
		}
	}

	return session.userId
}

export async function requireUserId(
	request: Request,
	{ redirectTo }: { redirectTo?: string | null } = {},
) {
	const userId = await getUserId(request)
	if (!userId) {
		const requestUrl = new URL(request.url)
		redirectTo =
			redirectTo === null
				? null
				: (redirectTo ?? `${requestUrl.pathname}${requestUrl.search}`)
		const loginParams = redirectTo ? new URLSearchParams({ redirectTo }) : null
		const loginRedirect = ['/login', loginParams?.toString()]
			.filter(Boolean)
			.join('?')
		throw redirect(loginRedirect)
	}
	return userId
}

export async function requireAnonymous(request: Request) {
	const userId = await getUserId(request)
	if (userId) {
		throw redirect('/')
	}
}

export async function canUserLogin(userId: string): Promise<boolean> {
	const [user] = await db
		.select({ isBanned: User.isBanned, banExpiresAt: User.banExpiresAt })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	if (!user) return false

	if (!user.isBanned) return true

	const now = new Date()
	const banExpired = user.banExpiresAt && new Date(user.banExpiresAt) <= now

	if (banExpired) {
		await db
			.update(User)
			.set({
				isBanned: false,
				banReason: null,
				banExpiresAt: null,
				bannedAt: null,
				bannedById: null,
			})
			.where(eq(User.id, userId))
		return true
	}

	return false
}

export async function logout(
	{
		request,
		redirectTo = '/',
	}: {
		request: Request
		redirectTo?: string
	},
	responseInit?: ResponseInit,
) {
	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const sessionId = authSession.get(sessionKey)

	let userId: string | undefined
	if (sessionId) {
		const [session] = await db
			.select({ userId: Session.userId })
			.from(Session)
			.where(eq(Session.id, sessionId))
			.limit(1)
		userId = session?.userId

		if (userId) {
			const { auditService, AuditAction } = await import('@repo/audit')
			void auditService.logAuth(
				AuditAction.USER_LOGOUT,
				userId,
				'User logged out',
				{ sessionId },
				request,
				true,
			)
		}

		void db
			.delete(Session)
			.where(eq(Session.id, sessionId))
			.catch(() => {})
	}
	throw redirect(safeRedirect(redirectTo), {
		...responseInit,
		headers: combineHeaders(
			{ 'set-cookie': await authSessionStorage.destroySession(authSession) },
			responseInit?.headers,
		),
	})
}

export async function getPasswordHash(password: string) {
	const hash = await bcrypt.hash(password, 12)
	return hash
}

export async function verifyUserPassword(
	where:
		Pick<UserRow, 'username'> | Pick<UserRow, 'id'> | Pick<UserRow, 'email'>,
	password: PasswordRow['hash'],
) {
	const [userWithPassword] = await db
		.select({ id: User.id, hash: Password.hash })
		.from(User)
		.leftJoin(Password, eq(Password.userId, User.id))
		.where(userWhere(where))
		.limit(1)

	if (!userWithPassword || !userWithPassword.hash) {
		return null
	}

	const isValid = await bcrypt.compare(password, userWithPassword.hash)

	if (!isValid) {
		return null
	}

	return { id: userWithPassword.id }
}

export function getPasswordHashParts(password: string) {
	const hash = crypto
		.createHash('sha1')
		.update(password, 'utf8')
		.digest('hex')
		.toUpperCase()
	return [hash.slice(0, 5), hash.slice(5)] as const
}

export async function checkIsCommonPassword(password: string) {
	const [prefix, suffix] = getPasswordHashParts(password)

	try {
		const response = await fetch(
			`https://api.pwnedpasswords.com/range/${prefix}`,
			{ signal: AbortSignal.timeout(1000) },
		)

		if (!response.ok) return false

		const data = await response.text()
		return data.split(/\r?\n/).some((line) => {
			const [hashSuffix] = line.split(':')
			return hashSuffix === suffix
		})
	} catch (error) {
		if (error instanceof DOMException && error.name === 'TimeoutError') {
			console.warn('Password check timed out')
			return false
		}

		console.warn('Unknown error during password check', error)
		return false
	}
}
