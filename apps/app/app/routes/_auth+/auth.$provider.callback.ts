import {
	getUserId,
	normalizeEmail,
	normalizeUsername,
	verifySessionStorage,
} from '@repo/auth'
import { ProviderNameSchema, providerLabels } from '@repo/auth/constants'
import { combineHeaders } from '@repo/common'
import { ensurePrimary } from '@repo/common/litefs'
import {
	destroyRedirectToHeaders,
	getRedirectCookieValue,
} from '@repo/common/redirect-cookie'
import { createToastHeaders, redirectWithToast } from '@repo/common/toast'
import { and, db, eq, Connection, Session, User } from '@repo/database'
import { redirect } from 'react-router'
import {
	authenticator,
	getSessionExpirationDate,
} from '#app/utils/auth.server.ts'
import { checkSSOEnforcementByEmail } from '#app/utils/sso/enforcement.server.ts'
import { type Route } from './+types/auth.$provider.callback.ts'
import { handleNewSession } from './login.server.ts'
import { onboardingEmailSessionKey } from './onboarding.tsx'
import { prefilledProfileKey, providerIdKey } from './onboarding_.$provider.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	// this loader performs mutations, so we need to make sure we're on the
	// primary instance to avoid writing to a read-only replica
	await ensurePrimary()

	const providerName = ProviderNameSchema.parse(params.provider)
	const redirectTo = getRedirectCookieValue(request)
	const label = providerLabels[providerName]

	const authResult = await authenticator
		.authenticate(providerName, request)
		.then(
			(data) =>
				({
					success: true,
					data,
				}) as const,
			(error) =>
				({
					success: false,
					error,
				}) as const,
		)

	if (!authResult.success) {
		console.error(authResult.error)
		throw await redirectWithToast(
			'/login',
			{
				title: 'Auth Failed',
				description: `There was an error authenticating with ${label}.`,
				type: 'error',
			},
			{ headers: destroyRedirectToHeaders(request) },
		)
	}

	const { data: profile } = authResult

	const [existingConnection] = await db
		.select({ userId: Connection.userId })
		.from(Connection)
		.where(
			and(
				eq(Connection.providerName, providerName),
				eq(Connection.providerId, String(profile.id)),
			),
		)
		.limit(1)

	const userId = await getUserId(request)

	if (existingConnection && userId) {
		if (existingConnection.userId === userId) {
			return redirectWithToast(
				'/settings',
				{
					title: 'Already Connected',
					description: `Your "${profile.username}" ${label} account is already connected.`,
				},
				{ headers: destroyRedirectToHeaders(request) },
			)
		} else {
			return redirectWithToast(
				'/settings',
				{
					title: 'Already Connected',
					description: `The "${profile.username}" ${label} account is already connected to another account.`,
				},
				{ headers: destroyRedirectToHeaders(request) },
			)
		}
	}

	// If we're already logged in, then link the account
	if (userId) {
		await db.insert(Connection).values({
			providerName,
			providerId: String(profile.id),
			userId,
		})
		return redirectWithToast(
			'/settings',
			{
				title: 'Connected',
				type: 'success',
				description: `Your "${profile.username}" ${label} account has been connected.`,
			},
			{ headers: destroyRedirectToHeaders(request) },
		)
	}

	// Connection exists already? Make a new session
	if (existingConnection) {
		// Check SSO enforcement before allowing social login
		const ssoEnforcement = await checkSSOEnforcementByEmail(profile.email)
		if (ssoEnforcement.enforced) {
			throw await redirectWithToast(
				`/auth/sso/${ssoEnforcement.organizationSlug}`,
				{
					title: 'SSO Required',
					description: `Your organization "${ssoEnforcement.organizationName}" requires SSO login.`,
					type: 'message',
				},
				{ headers: destroyRedirectToHeaders(request) },
			)
		}
		return makeSession({
			request,
			userId: existingConnection.userId,
			redirectTo,
		})
	}

	// if the email matches a user in the db, then link the account and
	// make a new session
	const [user] = await db
		.select({ id: User.id })
		.from(User)
		.where(eq(User.email, profile.email.toLowerCase()))
		.limit(1)
	if (user) {
		// Check SSO enforcement before allowing social login
		const ssoEnforcement = await checkSSOEnforcementByEmail(profile.email)
		if (ssoEnforcement.enforced) {
			throw await redirectWithToast(
				`/auth/sso/${ssoEnforcement.organizationSlug}`,
				{
					title: 'SSO Required',
					description: `Your organization "${ssoEnforcement.organizationName}" requires SSO login.`,
					type: 'message',
				},
				{ headers: destroyRedirectToHeaders(request) },
			)
		}

		await db.insert(Connection).values({
			providerName,
			providerId: String(profile.id),
			userId: user.id,
		})
		return makeSession(
			{ request, userId: user.id, redirectTo },
			{
				headers: await createToastHeaders({
					title: 'Connected',
					description: `Your "${profile.username}" ${label} account has been connected.`,
				}),
			},
		)
	}

	// this is a new user, so let's get them onboarded
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	verifySession.set(onboardingEmailSessionKey, profile.email)
	verifySession.set(prefilledProfileKey, {
		...profile,
		email: normalizeEmail(profile.email),
		username:
			typeof profile.username === 'string'
				? normalizeUsername(profile.username)
				: undefined,
	})
	verifySession.set(providerIdKey, profile.id)
	const onboardingRedirect = [
		`/onboarding/${providerName}`,
		redirectTo ? new URLSearchParams({ redirectTo }) : null,
	]
		.filter(Boolean)
		.join('?')
	return redirect(onboardingRedirect, {
		headers: combineHeaders(
			{ 'set-cookie': await verifySessionStorage.commitSession(verifySession) },
			destroyRedirectToHeaders(request),
		),
	})
}

async function makeSession(
	{
		request,
		userId,
		redirectTo,
	}: { request: Request; userId: string; redirectTo?: string | null },
	responseInit?: ResponseInit,
) {
	redirectTo ??= '/'

	const { canUserLogin } = await import('@repo/auth')
	const allowed = await canUserLogin(userId)
	if (!allowed) {
		return redirect('/login?banned=true', {
			headers: combineHeaders(
				responseInit?.headers,
				destroyRedirectToHeaders(request),
			),
		})
	}

	const { getClientIp } = await import('@repo/security')
	const { getUserAgent } = await import('#app/utils/user-agent.server.ts')

	const ipAddress = getClientIp(request)
	const userAgent = getUserAgent(request)

	const [session] = await db
		.insert(Session)
		.values({
			expirationDate: getSessionExpirationDate(false),
			userId,
			ipAddress,
			userAgent,
		})
		.returning({
			id: Session.id,
			expirationDate: Session.expirationDate,
			userId: Session.userId,
		})
	if (!session) throw new Error('Failed to create session')
	return handleNewSession(
		{ request, session, redirectTo, remember: false },
		{
			headers: combineHeaders(
				responseInit?.headers,
				destroyRedirectToHeaders(request),
			),
		},
	)
}
