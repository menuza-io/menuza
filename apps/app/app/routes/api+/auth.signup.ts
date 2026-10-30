import { parseWithZod } from '@conform-to/zod/v4'
import { db, eq, User } from '@repo/database'
import { checkHoneypot } from '@repo/security'
import { EmailSchema } from '@repo/validation'
import { data } from 'react-router'
import { z } from 'zod'
import { prepareVerification } from '#app/routes/_auth+/verify.server.tsx'
import { type Route } from './+types/auth.signup.ts'

const SignupFormSchema = z.object({
	email: EmailSchema,
})

export async function action({ request }: Route.ActionArgs) {
	try {
		const formData = await request.formData()

		// Check honeypot
		try {
			await checkHoneypot(formData)
		} catch {
			return data(
				{
					success: false,
					error: 'spam_detected',
					message: 'Form submission failed security check',
				},
				{ status: 400 },
			)
		}

		const submission = await parseWithZod(formData, {
			schema: SignupFormSchema.superRefine(async (data, ctx) => {
				const [existingUser] = await db
					.select({ id: User.id })
					.from(User)
					.where(eq(User.email, data.email))
					.limit(1)
				if (existingUser) {
					ctx.addIssue({
						path: ['email'],
						code: z.ZodIssueCode.custom,
						message: 'A user already exists with this email',
					})
					return
				}
			}),
			async: true,
		})

		if (submission.status !== 'success') {
			return data(
				{
					success: false,
					error: 'validation_failed',
					message: 'Validation failed',
					issues: submission.status === 'error' ? submission.error : undefined,
				},
				{ status: 400 },
			)
		}

		const { email } = submission.value

		// Prepare verification (sends email with 6-digit code)
		await prepareVerification({
			period: 10 * 60, // 10 minutes
			request,
			type: 'onboarding',
			target: email,
		})

		return data({
			success: true,
			data: {
				email,
				verificationRequired: true,
			},
		})
	} catch (error) {
		console.error('Signup action error:', error)
		return data(
			{
				success: false,
				error: 'internal_error',
				message: 'An unexpected error occurred. Please try again.',
			},
			{ status: 500 },
		)
	}
}
