import { invariant } from '@epic-web/invariant'
import { verifySessionStorage } from '@repo/auth'
import { db, eq, or, User } from '@repo/database'
import { data, redirect } from 'react-router'
import {
	createResetPasswordGrant,
	resetPasswordGrantSessionKey,
} from './reset-password-grant.server.ts'
import { resetPasswordUsernameSessionKey } from './reset-password.tsx'
import { type VerifyFunctionArgs } from './verify.server.tsx'

export async function handleVerification({
	request,
	submission,
}: VerifyFunctionArgs) {
	invariant(
		submission.status === 'success',
		'Submission should be successful by now',
	)
	const target = submission.value.target
	const [user] = await db
		.select({ email: User.email, username: User.username })
		.from(User)
		.where(or(eq(User.email, target), eq(User.username, target)))
		.limit(1)
	// we don't want to say the user is not found if the email is not found
	// because that would allow an attacker to check if an email is registered
	if (!user) {
		return data(
			{ result: submission.reply({ fieldErrors: { code: ['Invalid code'] } }) },
			{ status: 400 },
		)
	}

	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	verifySession.set(resetPasswordUsernameSessionKey, user.username)
	verifySession.set(
		resetPasswordGrantSessionKey,
		await createResetPasswordGrant(user.username),
	)
	return redirect('/reset-password', {
		headers: {
			'set-cookie': await verifySessionStorage.commitSession(verifySession),
		},
	})
}
