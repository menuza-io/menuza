import { getUtmParams } from '@repo/analytics'
import {
	canUserLogin,
	getPasswordHash,
	type ProviderUser,
	verifyUserPassword,
	providers,
} from '@repo/auth'

import { downloadFile } from '@repo/common'
import {
	Connection as ConnectionTable,
	db,
	eq,
	Password,
	Role,
	Session,
	User as UserTable,
	_RoleToUser,
	UtmSource,
	UserImage,
} from '@repo/database'
import { type Connection, type User } from '@repo/database/types'
import { getClientIp } from '@repo/security'
import { Authenticator } from 'remix-auth'
import { ssoAuthService } from './sso/auth.server.ts'
import { uploadProfileImage } from './storage.server.ts'
import { getUserAgent } from './user-agent.server.ts'

export { canUserLogin }

export const SESSION_EXPIRATION_TIME_SHORT = 1000 * 60 * 60 * 24 // 24 hours (default)
export const SESSION_EXPIRATION_TIME_LONG = 1000 * 60 * 60 * 24 * 30 // 30 days (remember me)
export const getSessionExpirationDate = (remember = false) =>
	new Date(
		Date.now() +
			(remember ? SESSION_EXPIRATION_TIME_LONG : SESSION_EXPIRATION_TIME_SHORT),
	)

/**
 * Extract IP address and user agent from request for session tracking
 */
function getSessionMetadata(request?: Request) {
	if (!request) return { ipAddress: null, userAgent: null }
	return {
		ipAddress: getClientIp(request),
		userAgent: getUserAgent(request),
	}
}

export const authenticator = new Authenticator<ProviderUser>()

// Register existing OAuth providers (GitHub, Google, etc.)
for (const [providerName, provider] of Object.entries(providers)) {
	const strategy = provider.getAuthStrategy()
	if (strategy) {
		authenticator.use(strategy, providerName)
	}
}

/**
 * Get or register an SSO strategy for an organization
 * This creates dynamic strategies based on organization SSO configuration
 */
export async function getSSOStrategy(organizationId: string) {
	const strategyName = `sso-${organizationId}`

	// Check if strategy is already registered
	try {
		// Try to get the existing strategy - this will throw if not found
		const existingStrategy = (authenticator as any)._strategies.get(
			strategyName,
		)
		if (existingStrategy) {
			return strategyName
		}
	} catch {
		// Strategy doesn't exist, we'll create it below
	}

	// Get the SSO strategy from the service
	const strategy = await ssoAuthService.getStrategy(organizationId)
	if (!strategy) {
		return null
	}

	// Register the strategy with the authenticator
	authenticator.use(strategy, strategyName)

	return strategyName
}

export async function login({
	username,
	password,
	request,
	remember = false,
}: {
	username: string
	password: string
	request?: Request
	remember?: boolean
}) {
	// Try to find user by username first, then by email if it looks like an email
	let user = null

	if (username.includes('@')) {
		// Looks like an email, try email first
		user = await verifyUserPassword({ email: username }, password)
		if (!user) {
			// If email fails, try as username (in case someone has @ in their username)
			user = await verifyUserPassword({ username }, password)
		}
	} else {
		// Looks like a username, try username first
		user = await verifyUserPassword({ username }, password)
		if (!user) {
			// If username fails, try as email (in case it's a short email)
			user = await verifyUserPassword({ email: username }, password)
		}
	}

	if (!user) return null

	const canLogin = await canUserLogin(user.id)
	if (!canLogin) return null

	const { ipAddress, userAgent } = getSessionMetadata(request)

	const [session] = await db
		.insert(Session)
		.values({
			expirationDate: getSessionExpirationDate(remember),
			ipAddress,
			userAgent,
			userId: user.id,
		})
		.returning({
			id: Session.id,
			expirationDate: Session.expirationDate,
			userId: Session.userId,
		})
	return session!
}

export async function resetUserPassword({
	username,
	password,
}: {
	username: User['username']
	password: string
}) {
	const hashedPassword = await getPasswordHash(password)
	const [user] = await db
		.select({ id: UserTable.id })
		.from(UserTable)
		.where(eq(UserTable.username, username))
		.limit(1)
	if (!user) throw new Error('User not found')
	await db
		.insert(Password)
		.values({ userId: user.id, hash: hashedPassword })
		.onConflictDoUpdate({
			target: Password.userId,
			set: { hash: hashedPassword },
		})
	return user
}

export async function signup({
	email,
	username,
	password,
	name,
	request,
}: {
	email: User['email']
	username: User['username']
	name: User['name']
	password: string
	request?: Request
}) {
	const hashedPassword = await getPasswordHash(password)

	// Get UTM parameters from cookies if request is provided
	const utmParams = request ? await getUtmParams(request) : null

	const { ipAddress, userAgent } = getSessionMetadata(request)

	const session = await db.transaction(async (tx) => {
		const [user] = await tx
			.insert(UserTable)
			.values({
				email: email.toLowerCase(),
				username: username.toLowerCase(),
				name,
			})
			.returning({ id: UserTable.id })
		if (!user) throw new Error('Failed to create user')
		const [role] = await tx
			.select({ id: Role.id })
			.from(Role)
			.where(eq(Role.name, 'user'))
			.limit(1)
		if (role) {
			await tx.insert(_RoleToUser).values({ A: role.id, B: user.id })
		}
		await tx.insert(Password).values({ userId: user.id, hash: hashedPassword })
		if (utmParams) {
			await tx.insert(UtmSource).values({
				userId: user.id,
				source: utmParams.source,
				medium: utmParams.medium,
				campaign: utmParams.campaign,
				term: utmParams.term,
				content: utmParams.content,
				referrer: utmParams.referrer,
			})
		}
		const [createdSession] = await tx
			.insert(Session)
			.values({
				expirationDate: getSessionExpirationDate(),
				ipAddress,
				userAgent,
				userId: user.id,
			})
			.returning({
				id: Session.id,
				expirationDate: Session.expirationDate,
				userId: Session.userId,
			})
		return createdSession!
	})

	return session
}

export async function signupWithConnection({
	email,
	username,
	name,
	providerId,
	providerName,
	imageUrl,
	request,
}: {
	email: User['email']
	username: User['username']
	name: User['name']
	providerId: Connection['providerId']
	providerName: Connection['providerName']
	imageUrl?: string
	request?: Request
}) {
	const [user] = await db
		.insert(UserTable)
		.values({
			email: email.toLowerCase(),
			username: username.toLowerCase(),
			name,
		})
		.returning({ id: UserTable.id })
	if (!user) throw new Error('Failed to create user')
	const [role] = await db
		.select({ id: Role.id })
		.from(Role)
		.where(eq(Role.name, 'user'))
		.limit(1)
	if (role) await db.insert(_RoleToUser).values({ A: role.id, B: user.id })
	await db
		.insert(ConnectionTable)
		.values({ userId: user.id, providerId, providerName })

	if (imageUrl) {
		const imageFile = await downloadFile(imageUrl)
		await db.insert(UserImage).values({
			userId: user.id,
			objectKey: await uploadProfileImage(user.id, imageFile),
		})
	}

	// Create and return the session
	const { ipAddress, userAgent } = getSessionMetadata(request)

	const [session] = await db
		.insert(Session)
		.values({
			expirationDate: getSessionExpirationDate(),
			userId: user.id,
			ipAddress,
			userAgent,
		})
		.returning({
			id: Session.id,
			expirationDate: Session.expirationDate,
			userId: Session.userId,
		})

	return session!
}

/**
 * Create session for SSO authenticated user
 */
export async function loginWithSSO({
	user,
	_organizationId,
	request,
}: {
	user: User
	_organizationId: string
	request?: Request
}) {
	const canLogin = await canUserLogin(user.id)
	if (!canLogin) {
		throw new Error('User is banned and cannot login')
	}

	const { ipAddress, userAgent } = getSessionMetadata(request)

	const [session] = await db
		.insert(Session)
		.values({
			expirationDate: getSessionExpirationDate(),
			ipAddress,
			userAgent,
			userId: user.id,
		})
		.returning({
			id: Session.id,
			expirationDate: Session.expirationDate,
			userId: Session.userId,
		})

	return session!
}
