import { parseWithZod } from '@conform-to/zod/v4'
import { verifySessionStorage } from '@repo/auth'
import { db, eq, User } from '@repo/database'
import { z } from 'zod'

import { newEmailAddressSessionKey } from '#app/routes/_app+/security.tsx'
import { prepareVerification } from '#app/routes/_auth+/verify.server.tsx'

export const ChangeEmailSchema = z.object({
	email: z.string().email({ message: 'Please provide a valid email address' }),
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

	const { otp, verifyUrl } = await prepareVerification({
		period: 10 * 60,
		request,
		target: userId,
		type: 'change-email',
	})

	const verifySession = await verifySessionStorage.getSession()
	verifySession.set(newEmailAddressSessionKey, submission.value.email)

	return Response.json(
		{
			status: 'success',
			result: submission.reply(),
			verificationInfo: {
				otp,
				verifyUrl: verifyUrl.toString(),
				email: submission.value.email,
			},
		},
		{
			headers: {
				'set-cookie': await verifySessionStorage.commitSession(verifySession),
			},
		},
	)
}
