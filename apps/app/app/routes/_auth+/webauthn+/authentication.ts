import { db, eq, Passkey, Session } from '@repo/database'
import {
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { getSessionExpirationDate } from '#app/utils/auth.server.ts'
import { handleNewSession } from '../login.server.ts'
import { type Route } from './+types/authentication.ts'
import {
	PasskeyLoginBodySchema,
	getWebAuthnConfig,
	passkeyCookie,
} from './utils.server.ts'

export async function loader({ request }: Route.LoaderArgs) {
	const config = getWebAuthnConfig(request)
	const options = await generateAuthenticationOptions({
		rpID: config.rpID,
		userVerification: 'preferred',
	})

	const cookieHeader = await passkeyCookie.serialize({
		challenge: options.challenge,
	})

	return Response.json({ options }, { headers: { 'Set-Cookie': cookieHeader } })
}

export async function action({ request }: Route.ActionArgs) {
	const cookieHeader = request.headers.get('Cookie')
	const cookie = await passkeyCookie.parse(cookieHeader)
	const deletePasskeyCookie = await passkeyCookie.serialize('', { maxAge: 0 })
	try {
		if (!cookie?.challenge) {
			throw new Error('Authentication challenge not found')
		}

		const body = await request.json()
		const result = PasskeyLoginBodySchema.safeParse(body)
		if (!result.success) {
			throw new Error('Invalid authentication response')
		}
		const { authResponse, remember, redirectTo } = result.data

		const config = getWebAuthnConfig(request)

		// Wrap read-verify-update in a transaction to prevent race conditions
		// that could allow replay attacks with the same counter value
		const { passkey } = await db.transaction(async (tx) => {
			const [passkey] = await tx
				.select()
				.from(Passkey)
				.where(eq(Passkey.id, authResponse.id))
				.limit(1)
			if (!passkey) {
				throw new Error('Passkey not found')
			}

			const verification = await verifyAuthenticationResponse({
				response: authResponse,
				expectedChallenge: cookie.challenge,
				expectedOrigin: config.origin,
				expectedRPID: config.rpID,
				credential: {
					id: authResponse.id,
					publicKey: Uint8Array.from(passkey.publicKey),
					counter: Number(passkey.counter),
				},
			})

			if (!verification.verified) {
				throw new Error('Authentication verification failed')
			}

			// Update the authenticator's counter in the DB to the newest count
			await tx
				.update(Passkey)
				.set({ counter: verification.authenticationInfo.newCounter })
				.where(eq(Passkey.id, passkey.id))

			return { passkey }
		})

		// Check if user is banned before creating session
		const { canUserLogin } = await import('@repo/auth')
		const allowed = await canUserLogin(passkey.userId)
		if (!allowed) {
			return Response.json(
				{
					status: 'error',
					error: 'Account suspended',
				},
				{ status: 403, headers: { 'Set-Cookie': deletePasskeyCookie } },
			)
		}

		const { checkSSOEnforcementByUserId } =
			await import('#app/utils/sso/enforcement.server.ts')
		const ssoEnforcement = await checkSSOEnforcementByUserId(passkey.userId)
		if (ssoEnforcement.enforced) {
			return Response.json(
				{
					status: 'error',
					error: 'Your organization requires SSO login',
				},
				{ status: 403, headers: { 'Set-Cookie': deletePasskeyCookie } },
			)
		}

		const { getClientIp } = await import('@repo/security')
		const { getUserAgent } = await import('#app/utils/user-agent.server.ts')

		const ipAddress = getClientIp(request)
		const userAgent = getUserAgent(request)

		const [session] = await db
			.insert(Session)
			.values({
				expirationDate: getSessionExpirationDate(remember),
				userId: passkey.userId,
				ipAddress,
				userAgent,
			})
			.returning({
				id: Session.id,
				expirationDate: Session.expirationDate,
				userId: Session.userId,
			})
		if (!session) throw new Error('Failed to create session')

		const response = await handleNewSession(
			{
				request,
				session,
				remember,
				redirectTo: redirectTo ?? undefined,
			},
			{ headers: { 'Set-Cookie': deletePasskeyCookie } },
		)

		return Response.json(
			{
				status: 'success',
				location: response.headers.get('Location'),
			},
			{ headers: response.headers },
		)
	} catch (error) {
		if (error instanceof Response) throw error

		return Response.json(
			{
				status: 'error',
				error: error instanceof Error ? error.message : 'Verification failed',
			} as const,
			{ status: 400, headers: { 'Set-Cookie': deletePasskeyCookie } },
		)
	}
}
