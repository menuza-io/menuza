import { requireUserId } from '@repo/auth'
import { getDomainUrl, getErrorMessage } from '@repo/common'
import { db, eq, Passkey, User } from '@repo/database'
import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { refuseWhileImpersonating } from '#app/utils/impersonation-guard.server.ts'
import { type Route } from './+types/registration.ts'
import {
	PasskeyCookieSchema,
	RegistrationResponseSchema,
	passkeyCookie,
	getWebAuthnConfig,
} from './utils.server.ts'

export async function loader({ request }: Route.LoaderArgs) {
	try {
		const userId = await requireUserId(request)
		const passkeys = await db
			.select({ id: Passkey.id })
			.from(Passkey)
			.where(eq(Passkey.userId, userId))
		const [user] = await db
			.select({
				email: User.email,
				name: User.name,
				username: User.username,
			})
			.from(User)
			.where(eq(User.id, userId))
			.limit(1)
		if (!user) throw new Error('User not found')

		const config = getWebAuthnConfig(request)

		const options = await generateRegistrationOptions({
			rpName: config.rpName,
			rpID: config.rpID,
			userName: user.username,
			userID: new TextEncoder().encode(userId),
			userDisplayName: user.name ?? user.email,
			attestationType: 'none',
			excludeCredentials: passkeys,
			authenticatorSelection: {
				residentKey: 'preferred',
				userVerification: 'preferred',
			},
		})

		return Response.json(
			{ options },
			{
				headers: {
					'Set-Cookie': await passkeyCookie.serialize(
						PasskeyCookieSchema.parse({
							challenge: options.challenge,
							userId: options.user.id,
						}),
					),
				},
			},
		)
	} catch (error) {
		console.error('WebAuthn registration loader error:', error)
		return Response.json({ error: getErrorMessage(error) }, { status: 500 })
	}
}

export async function action({ request }: Route.ActionArgs) {
	// Outside the try: the catch below would turn the 403 into a 500.
	await refuseWhileImpersonating(request)
	try {
		const userId = await requireUserId(request)

		const body = await request.json()
		const result = RegistrationResponseSchema.safeParse(body)
		if (!result.success) {
			console.error('Invalid registration response:', result.error)
			throw new Error('Invalid registration response')
		}

		const data = result.data

		const passkeyCookieData = await passkeyCookie.parse(
			request.headers.get('Cookie'),
		)
		const parsedPasskeyCookieData =
			PasskeyCookieSchema.safeParse(passkeyCookieData)
		if (!parsedPasskeyCookieData.success) {
			console.error(
				'Cookie parse error:',
				passkeyCookieData,
				parsedPasskeyCookieData.error,
			)
			throw new Error('No challenge found')
		}
		const { challenge, userId: webauthnUserId } = parsedPasskeyCookieData.data

		const domainUrl = getDomainUrl(request)

		const domain = new URL(domainUrl).hostname
		const rpID = domain
		const origin = domainUrl

		const verification = await verifyRegistrationResponse({
			response: data,
			expectedChallenge: challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			requireUserVerification: true,
		})

		const { verified, registrationInfo } = verification
		if (!verified || !registrationInfo) {
			console.error('Verification failed:', verification)
			throw new Error('Registration verification failed')
		}
		const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
			registrationInfo

		const [existingPasskey] = await db
			.select({ id: Passkey.id })
			.from(Passkey)
			.where(eq(Passkey.id, credential.id))
			.limit(1)

		if (existingPasskey) {
			throw new Error('This passkey has already been registered')
		}

		await db.insert(Passkey).values({
			id: credential.id,
			aaguid,
			publicKey: Buffer.from(credential.publicKey),
			userId,
			webauthnUserId,
			counter: credential.counter,
			deviceType: credentialDeviceType,
			backedUp: credentialBackedUp,
			transports: credential.transports?.join(','),
		})

		return Response.json({ status: 'success' } as const, {
			headers: {
				'Set-Cookie': await passkeyCookie.serialize('', { maxAge: 0 }),
			},
		})
	} catch (error) {
		console.error('Passkey registration error:', error)
		if (error instanceof Response) throw error

		return Response.json(
			{ status: 'error', error: getErrorMessage(error) } as const,
			{ status: 400 },
		)
	}
}
