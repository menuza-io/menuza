import { invariant } from '@epic-web/invariant'
import { auditService, AuditAction } from '@repo/audit'
import {
	authSessionStorage,
	verifySessionStorage,
	getUserId,
	safeDocumentRedirect,
	sessionKey,
} from '@repo/auth'
import { combineResponseInits } from '@repo/common'
import { redirectWithToast } from '@repo/common/toast'
import { and, db, eq, Verification, Session } from '@repo/database'
import { redirect } from 'react-router'
import { handleNewDeviceSignin } from '#app/utils/new-device-signin.server.tsx'
import { twoFAVerificationType } from '../_app+/security.tsx'
import { getRedirectToUrl, type VerifyFunctionArgs } from './verify.server.tsx'

const verifiedTimeKey = 'verified-time'
const unverifiedSessionIdKey = 'unverified-session-id'
const rememberKey = 'remember'

export async function handleNewSession(
	{
		request,
		session,
		redirectTo,
		remember,
	}: {
		request: Request
		session: { userId: string; id: string; expirationDate: Date }
		redirectTo?: string
		remember: boolean
	},
	responseInit?: ResponseInit,
) {
	const [verification] = await db
		.select({ id: Verification.id })
		.from(Verification)
		.where(
			and(
				eq(Verification.target, session.userId),
				eq(Verification.type, twoFAVerificationType),
			),
		)
		.limit(1)
	const userHasTwoFactor = Boolean(verification)

	// Check for new device and send notification email (async, don't wait)
	void handleNewDeviceSignin({
		userId: session.userId,
		request,
	})

	if (userHasTwoFactor) {
		const verifySession = await verifySessionStorage.getSession(
			request.headers.get('cookie'),
		)
		verifySession.set(unverifiedSessionIdKey, session.id)
		verifySession.set(rememberKey, remember)
		const redirectUrl = getRedirectToUrl({
			request,
			type: twoFAVerificationType,
			target: session.userId,
			redirectTo,
		})
		return redirect(
			`${redirectUrl.pathname}?${redirectUrl.searchParams}`,
			combineResponseInits(
				{
					headers: {
						'set-cookie':
							await verifySessionStorage.commitSession(verifySession),
					},
				},
				responseInit,
			),
		)
	} else {
		const authSession = await authSessionStorage.getSession(
			request.headers.get('cookie'),
		)
		authSession.set(sessionKey, session.id)

		// Log successful login (SOC 2 CC7.2)
		void auditService.logAuth(
			AuditAction.USER_LOGIN,
			session.userId,
			'User logged in successfully',
			{ loginMethod: 'password', hasTwoFactor: false },
			request,
			true,
		)

		return redirect(
			safeDocumentRedirect(redirectTo),
			combineResponseInits(
				{
					headers: {
						'set-cookie': await authSessionStorage.commitSession(authSession, {
							expires: remember ? session.expirationDate : undefined,
						}),
					},
				},
				responseInit,
			),
		)
	}
}

export async function handleVerification({
	request,
	submission,
}: VerifyFunctionArgs) {
	invariant(
		submission.status === 'success',
		'Submission should be successful by now',
	)
	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)

	const remember = verifySession.get(rememberKey)
	const { redirectTo } = submission.value
	const headers = new Headers()
	authSession.set(verifiedTimeKey, Date.now())

	const unverifiedSessionId = verifySession.get(unverifiedSessionIdKey)
	if (unverifiedSessionId) {
		const [session] = await db
			.select({
				expirationDate: Session.expirationDate,
				userId: Session.userId,
			})
			.from(Session)
			.where(eq(Session.id, unverifiedSessionId))
			.limit(1)
		// The code must belong to the user whose session is being unlocked;
		// otherwise a valid 2FA code for any other account would complete login.
		if (!session || session.userId !== submission.value.target) {
			throw await redirectWithToast('/login', {
				type: 'error',
				title: 'Invalid session',
				description: 'Could not find session to verify. Please try again.',
			})
		}
		authSession.set(sessionKey, unverifiedSessionId)

		headers.append(
			'set-cookie',
			await authSessionStorage.commitSession(authSession, {
				expires: remember ? session.expirationDate : undefined,
			}),
		)
	} else {
		headers.append(
			'set-cookie',
			await authSessionStorage.commitSession(authSession),
		)
	}

	headers.append(
		'set-cookie',
		await verifySessionStorage.destroySession(verifySession),
	)

	// Log successful login with 2FA (SOC 2 CC7.2)
	const [sessionForLog] = await db
		.select({ userId: Session.userId })
		.from(Session)
		.where(eq(Session.id, unverifiedSessionId || ''))
		.limit(1)
	if (sessionForLog) {
		void auditService.logAuth(
			AuditAction.USER_LOGIN,
			sessionForLog.userId,
			'User logged in successfully with 2FA',
			{ loginMethod: 'password', hasTwoFactor: true },
			request,
			true,
		)
	}

	return redirect(safeDocumentRedirect(redirectTo), { headers })
}

export async function shouldRequestTwoFA(request: Request) {
	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	if (verifySession.has(unverifiedSessionIdKey)) return true
	const userId = await getUserId(request)
	if (!userId) return false
	// if it's over two hours since they last verified, we should request 2FA again
	const [userHasTwoFA] = await db
		.select({ id: Verification.id })
		.from(Verification)
		.where(
			and(
				eq(Verification.target, userId),
				eq(Verification.type, twoFAVerificationType),
			),
		)
		.limit(1)
	if (!userHasTwoFA) return false
	const verifiedTime = authSession.get(verifiedTimeKey) ?? new Date(0)
	const twoHours = 1000 * 60 * 60 * 2
	return Date.now() - verifiedTime > twoHours
}
