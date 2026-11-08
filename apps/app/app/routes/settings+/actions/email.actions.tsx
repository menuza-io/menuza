import { parseWithZod } from '@conform-to/zod/v4'
import { verifySessionStorage } from '@repo/auth'
import { brand } from '@repo/config/brand'
import { db, eq, User } from '@repo/database'
import { EmailChangeEmail, sendEmail } from '@repo/email'
import { EmailSchema } from '@repo/validation'
import { z } from 'zod'

import {
	newEmailAddressSessionKey,
	newEmailVerificationSessionKey,
} from '#app/routes/_app+/security.tsx'
import {
	hashVerificationSecret,
	prepareVerification,
} from '#app/routes/_auth+/verify.server.tsx'
import {
	CHANGE_EMAIL_RECIPIENT_RATE_LIMIT,
	CHANGE_EMAIL_USER_RATE_LIMIT,
	checkRateLimit,
} from '#app/utils/rate-limit.server.ts'

export const ChangeEmailSchema = z.object({
	// EmailSchema lowercases, so the uniqueness check, rate limits, cookie and
	// update all see the stored form of the address.
	email: EmailSchema,
})

type EmailActionArgs = {
	formData: FormData
	userId: string
	request: Request
}

export async function changeEmailAction({
	formData,
	userId,
	request,
}: EmailActionArgs) {
	const submission = await parseWithZod(formData, {
		schema: ChangeEmailSchema.superRefine(async (data, ctx) => {
			const [existingUser] = await db
				.select({ id: User.id })
				.from(User)
				.where(eq(User.email, data.email))
				.limit(1)
			if (existingUser) {
				ctx.addIssue({
					path: ['email'],
					code: z.ZodIssueCode.custom,
					message: 'This email is already in use.',
				})
			}
		}),
		async: true,
	})

	if (submission.status !== 'success') {
		return Response.json(
			{ result: submission.reply(), status: 'error' },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const newEmail = submission.value.email
	// The recipient is charged only for a request the user limit let through, so
	// someone over their own limit cannot use up an address they do not own.
	const userLimit = await checkRateLimit(
		{ type: 'user', value: userId },
		CHANGE_EMAIL_USER_RATE_LIMIT,
	)
	const recipientLimit = userLimit.allowed
		? await checkRateLimit(
				{ type: 'token', value: newEmail.toLowerCase() },
				CHANGE_EMAIL_RECIPIENT_RATE_LIMIT,
			)
		: { allowed: false }
	if (!userLimit.allowed || !recipientLimit.allowed) {
		return Response.json(
			{
				result: submission.reply({
					formErrors: ['Too many verification emails. Try again later.'],
				}),
				status: 'error',
			},
			{ status: 429 },
		)
	}

	const [account] = await db
		.select({ name: User.name, username: User.username })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	const firstName = (account?.name?.trim().split(/\s+/)[0] ||
		account?.username) as string | undefined

	const { otp, verifyUrl, secret } = await prepareVerification({
		period: 10 * 60,
		request,
		target: userId,
		type: 'change-email',
	})

	const verifySession = await verifySessionStorage.getSession()
	verifySession.set(newEmailAddressSessionKey, newEmail)
	// Names the code mailed to this address, so entering a code from an
	// overlapping request cannot apply an address it was not sent to.
	verifySession.set(
		newEmailVerificationSessionKey,
		await hashVerificationSecret(secret),
	)

	// The code goes only to the NEW address. Returning it to the requester
	// would let anyone claim an address they do not control (and the
	// invitations sent to it) without ever reading its mailbox.
	const response = await sendEmail({
		to: newEmail,
		subject: `Verify your new ${brand.name} email address`,
		react: (
			<EmailChangeEmail
				verifyUrl={verifyUrl.toString()}
				otp={otp}
				firstName={firstName}
			/>
		),
	})
	if (response.status !== 'success') {
		return Response.json(
			{
				result: submission.reply({ formErrors: [response.error.message] }),
				status: 'error',
			},
			{ status: 500 },
		)
	}

	return Response.json(
		{
			status: 'success',
			result: submission.reply(),
			verificationInfo: { email: newEmail },
		},
		{
			headers: {
				'set-cookie': await verifySessionStorage.commitSession(verifySession),
			},
		},
	)
}
