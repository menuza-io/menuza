import { generateTOTP, getTOTPAuthUri } from '@epic-web/totp'
import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import {
	authSessionStorage,
	requireUserId,
	sessionKey,
	getUnusedBackupCodeCount,
} from '@repo/auth'
import { cache, cachified } from '@repo/cache'
import {
	and,
	db,
	desc,
	eq,
	gt,
	Password,
	Passkey,
	Session,
	User,
	UserImage,
	Verification,
} from '@repo/database'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { PageTitle } from '@repo/ui/page-title'
import { toDataURL as qrCodeToDataURL } from 'qrcode'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useLoaderData,
} from 'react-router'
import { ConnectionsCard } from '#app/components/settings/cards/connections-card.tsx'
import { DangerCard } from '#app/components/settings/cards/danger-card.tsx'
import { PrivacyCard } from '#app/components/settings/cards/privacy-card.tsx'
import { SecurityCard } from '#app/components/settings/cards/security-card.tsx'
import { SessionsCard } from '#app/components/settings/cards/sessions-card.tsx'

import {
	getActiveErasureRequest,
	getLatestExportRequest,
} from '#app/utils/gdpr.server.ts'
import { refuseWhileImpersonating } from '#app/utils/impersonation-guard.server.ts'
import { checkSSOEnforcementByUserId } from '#app/utils/sso/enforcement.server.ts'
import { parseUserAgent } from '#app/utils/user-agent.server.ts'
import { getUserSecuritySelect } from '#app/utils/user-security.server.ts'
import { requireRecentVerification } from '../_auth+/verify.server.tsx'
import { signOutOfSessionsAction } from '../settings+/actions/account.actions'
import { disconnectProviderAction } from '../settings+/actions/connections.actions'
import {
	requestDataDeletionAction,
	cancelDataDeletionAction,
} from '../settings+/actions/privacy.actions'
import {
	changePasswordAction,
	disable2FAAction,
	enable2FAAction,
	generateBackupCodesAction,
	regenerateBackupCodesAction,
	setPasswordAction,
} from '../settings+/actions/security.actions'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)

	// Run all database queries in parallel for better performance
	// User query is cached with short TTL for security-sensitive data
	// Cache invalidated on security updates via invalidateUserSecurityCache()
	// Using Promise.allSettled for resilient error handling - non-critical queries
	// (connections, passkeys) gracefully degrade on failure
	const results = await Promise.allSettled([
		cachified({
			key: `user-security:${userId}`,
			cache,
			ttl: 1000 * 30, // 30 seconds for security-sensitive data
			getFreshValue: async () => {
				const [user] = await db
					.select(getUserSecuritySelect())
					.from(User)
					.leftJoin(UserImage, eq(UserImage.userId, User.id))
					.where(eq(User.id, userId))
					.limit(1)
				if (!user) throw new Error('User not found')
				return user
			},
		}),
		db
			.select({ id: Verification.id })
			.from(Verification)
			.where(
				and(
					eq(Verification.type, twoFAVerificationType),
					eq(Verification.target, userId),
				),
			)
			.limit(1),
		db
			.select({ userId: Password.userId })
			.from(Password)
			.where(eq(Password.userId, userId))
			.limit(1),
		db.query.Connection.findMany({
			columns: {
				id: true,
				providerName: true,
				providerId: true,
				createdAt: true,
			},
			where: (connection, { eq }) => eq(connection.userId, userId),
		}),
		// Get passkeys for this user
		db
			.select({
				id: Passkey.id,
				deviceType: Passkey.deviceType,
				createdAt: Passkey.createdAt,
			})
			.from(Passkey)
			.where(eq(Passkey.userId, userId))
			.orderBy(desc(Passkey.createdAt)),
		// Get all active sessions for this user
		db
			.select({
				id: Session.id,
				createdAt: Session.createdAt,
				expirationDate: Session.expirationDate,
				updatedAt: Session.updatedAt,
				ipAddress: Session.ipAddress,
				userAgent: Session.userAgent,
			})
			.from(Session)
			.where(
				and(eq(Session.userId, userId), gt(Session.expirationDate, new Date())),
			)
			.orderBy(desc(Session.createdAt)),
		checkSSOEnforcementByUserId(userId),
		getUnusedBackupCodeCount(userId),
		getActiveErasureRequest(userId),
		getLatestExportRequest(userId),
	])

	// Extract results with error handling
	const rawUser =
		results[0].status === 'fulfilled'
			? results[0].value
			: (() => {
					throw results[0].reason
				})()
	const twoFactorVerification =
		results[1].status === 'fulfilled' ? (results[1].value[0] ?? null) : null
	const password =
		results[2].status === 'fulfilled' ? (results[2].value[0] ?? null) : null
	const connections = results[3].status === 'fulfilled' ? results[3].value : []
	const passkeys = results[4].status === 'fulfilled' ? results[4].value : []
	const rawSessions = results[5].status === 'fulfilled' ? results[5].value : []
	const user = { ...rawUser, _count: { sessions: rawSessions.length } }
	const ssoEnforcement =
		results[6].status === 'fulfilled' ? results[6].value : { enforced: false }
	const backupCodesRemaining =
		results[7].status === 'fulfilled' ? results[7].value : 0
	const activeErasureRequest =
		results[8].status === 'fulfilled' ? results[8].value : null
	const latestExportRequest =
		results[9].status === 'fulfilled' ? results[9].value : null

	// Get current session ID
	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const currentSessionId = authSession.get(sessionKey) || null

	// Parse user agent for each session
	const sessions = rawSessions.map((session) => ({
		...session,
		deviceInfo: session.userAgent ? parseUserAgent(session.userAgent) : null,
	}))

	// Generate TOTP QR code if 2FA is not enabled
	let qrCode = null
	let otpUri = null
	if (!twoFactorVerification) {
		const { otp: _otp, ...config } = await generateTOTP()
		otpUri = getTOTPAuthUri({
			...config,
			accountName: user.email,
			issuer: 'Epic Stack',
		})

		qrCode = await qrCodeToDataURL(otpUri)

		const verificationData = {
			...config,
			type: twoFAVerifyVerificationType,
			target: userId,
		}

		// Store the TOTP config in the database temporarily
		await db
			.insert(Verification)
			.values(verificationData)
			.onConflictDoUpdate({
				target: [Verification.target, Verification.type],
				set: verificationData,
			})
	}

	return {
		user,
		hasPassword: Boolean(password),
		isTwoFactorEnabled: Boolean(twoFactorVerification),
		connections,
		qrCode,
		otpUri,
		passkeys,
		sessions,
		currentSessionId,
		ssoEnforcement,
		backupCodesRemaining,
		gdpr: {
			activeErasureRequest: activeErasureRequest
				? {
						id: activeErasureRequest.id,
						status: activeErasureRequest.status,
						scheduledFor: activeErasureRequest.scheduledFor?.toISOString(),
						requestedAt: activeErasureRequest.requestedAt.toISOString(),
					}
				: null,
			latestExportRequest: latestExportRequest
				? {
						id: latestExportRequest.id,
						status: latestExportRequest.status,
						completedAt: latestExportRequest.completedAt?.toISOString(),
						requestedAt: latestExportRequest.requestedAt.toISOString(),
					}
				: null,
		},
	}
}

type SecurityActionArgs = {
	request: Request
	userId: string
	formData: FormData
}

export const signOutOfSessionsActionIntent = 'sign-out-of-sessions'
export const revokeSessionActionIntent = 'revoke-session'
export const disconnectProviderActionIntent = 'disconnect-provider'
export const registerPasskeyActionIntent = 'register-passkey'
export const deletePasskeyActionIntent = 'delete-passkey'
export const changePasswordActionIntent = 'change-password'
export const setPasswordActionIntent = 'set-password'
export const enable2FAActionIntent = 'enable-2fa'
export const disable2FAActionIntent = 'disable-2fa'
export const generateBackupCodesActionIntent = 'generate-backup-codes'
export const regenerateBackupCodesActionIntent = 'regenerate-backup-codes'
export const requestDataDeletionActionIntent = 'request-data-deletion'
export const cancelDataDeletionActionIntent = 'cancel-data-deletion'
export const twoFAVerificationType = '2fa'
export const twoFAVerifyVerificationType = '2fa-verify'
export const newEmailAddressSessionKey = 'new-email-address'
/** Hash of the secret behind the code mailed to the pending new address. */
export const newEmailVerificationSessionKey = 'new-email-verification'

/** Intents that add, change or remove a way to sign in or a second factor. */
const CREDENTIAL_INTENTS = new Set<string>([
	disconnectProviderActionIntent,
	changePasswordActionIntent,
	setPasswordActionIntent,
	enable2FAActionIntent,
	disable2FAActionIntent,
	generateBackupCodesActionIntent,
	regenerateBackupCodesActionIntent,
	registerPasskeyActionIntent,
	deletePasskeyActionIntent,
])

/**
 * Erasure requests outlive an impersonation grant (they end every session and
 * schedule deletion) and are logged as the user's own request.
 */
const DATA_DELETION_INTENTS = new Set<string>([
	requestDataDeletionActionIntent,
	cancelDataDeletionActionIntent,
])

export async function action({ request }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const formData = await request.formData()
	const intent = formData.get('intent')

	if (typeof intent === 'string' && CREDENTIAL_INTENTS.has(intent)) {
		await refuseWhileImpersonating(request)
	}
	if (typeof intent === 'string' && DATA_DELETION_INTENTS.has(intent)) {
		await refuseWhileImpersonating(
			request,
			'Stop impersonating before requesting or cancelling account deletion',
		)
	}

	switch (intent) {
		case signOutOfSessionsActionIntent: {
			return signOutOfSessionsAction({ request, userId, formData })
		}
		case revokeSessionActionIntent: {
			return revokeSessionAction({ request, userId, formData })
		}
		case disconnectProviderActionIntent: {
			return disconnectProviderAction({ userId, formData })
		}
		case changePasswordActionIntent: {
			return changePasswordAction({ request, userId, formData })
		}
		case setPasswordActionIntent: {
			return setPasswordAction({ request, userId, formData })
		}
		case enable2FAActionIntent: {
			return enable2FAAction({ request, userId, formData })
		}
		case disable2FAActionIntent: {
			return disable2FAAction({ request, userId, formData })
		}
		case generateBackupCodesActionIntent: {
			// Backup codes are accepted as a 2FA factor (step-up, disable-2FA), so
			// minting them needs the same recent verification as those gates.
			await requireRecentVerification(request)
			return generateBackupCodesAction({ request, userId, formData })
		}
		case regenerateBackupCodesActionIntent: {
			await requireRecentVerification(request)
			return regenerateBackupCodesAction({ request, userId, formData })
		}
		case registerPasskeyActionIntent: {
			return registerPasskeyAction({ request, userId, formData })
		}
		case deletePasskeyActionIntent: {
			return deletePasskeyAction({ request, userId, formData })
		}
		case requestDataDeletionActionIntent: {
			return requestDataDeletionAction({ request, userId })
		}
		case cancelDataDeletionActionIntent: {
			return cancelDataDeletionAction({ request, userId })
		}
		default: {
			throw new Response(`Invalid intent "${intent}"`, { status: 400 })
		}
	}
}

// Mock function for passkey registration - in a real app, you'd use your passkey API
async function registerPasskeyAction(_args: SecurityActionArgs) {
	return { status: 'success' }
}

async function deletePasskeyAction({ formData, userId }: SecurityActionArgs) {
	const passkeyId = formData.get('passkeyId')
	if (typeof passkeyId !== 'string') {
		throw new Response('Invalid passkey ID', { status: 400 })
	}

	await db
		.delete(Passkey)
		.where(and(eq(Passkey.id, passkeyId), eq(Passkey.userId, userId)))

	return { status: 'success' }
}

async function revokeSessionAction({
	request,
	userId,
	formData,
}: SecurityActionArgs) {
	const sessionId = formData.get('sessionId')
	if (typeof sessionId !== 'string') {
		throw new Response('Invalid session ID', { status: 400 })
	}

	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const currentSessionId = authSession.get(sessionKey)

	// Prevent revoking the current session
	if (sessionId === currentSessionId) {
		throw new Response('Cannot revoke current session', { status: 400 })
	}

	await db
		.delete(Session)
		.where(and(eq(Session.id, sessionId), eq(Session.userId, userId)))

	return { status: 'success' }
}

export default function SecuritySettings() {
	const data = useLoaderData<typeof loader>()
	const { _ } = useLingui()

	return (
		<div className="mx-auto w-full max-w-4xl py-8 md:p-8">
			<div className="mb-8 md:mb-10">
				<PageTitle
					title={_(t`Security Settings`)}
					description={_(
						t`Manage your password, two-factor authentication, connected accounts, and advanced security settings.`,
					)}
				/>
			</div>

			<AnnotatedLayout>
				{/* Credentials: password, 2FA, passkeys */}
				<AnnotatedSection>
					<SecurityCard
						hasPassword={data.hasPassword}
						isTwoFactorEnabled={data.isTwoFactorEnabled}
						backupCodesRemaining={data.backupCodesRemaining}
						passkeys={data.passkeys}
						user={data.user}
						qrCode={data.qrCode}
						otpUri={data.otpUri}
						ssoEnforcement={data.ssoEnforcement}
					/>
				</AnnotatedSection>

				{/* Access: providers + active sessions */}
				<AnnotatedSection>
					<div className="flex flex-col gap-4">
						<ConnectionsCard user={data.user} connections={data.connections} />
						<SessionsCard
							sessions={data.sessions}
							currentSessionId={data.currentSessionId}
						/>
					</div>
				</AnnotatedSection>

				{/* Data rights */}
				<AnnotatedSection>
					<PrivacyCard
						gdpr={{ latestExportRequest: data.gdpr.latestExportRequest }}
					/>
				</AnnotatedSection>

				{/* Destructive — separated from routine settings */}
				<section className="border-border mt-2 border-t pt-10">
					<DangerCard
						gdpr={{ activeErasureRequest: data.gdpr.activeErasureRequest }}
					/>
				</section>
			</AnnotatedLayout>
		</div>
	)
}
