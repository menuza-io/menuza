import { parseWithZod } from '@conform-to/zod/v4'
import { verifySessionStorage, checkIsCommonPassword } from '@repo/auth'
import { db, eq, User } from '@repo/database'
import { checkHoneypot } from '@repo/security'
import {
	NameSchema,
	PasswordAndConfirmPasswordSchema,
	UsernameSchema,
} from '@repo/validation'
import { data } from 'react-router'
import { z } from 'zod'
import { signup } from '#app/utils/auth.server.ts'
import { createAuthenticatedSessionResponse } from '#app/utils/jwt.server.ts'
import { type Route } from './+types/auth.onboarding.ts'

export const onboardingEmailSessionKey = 'onboardingEmail'

const OnboardingFormSchema = z
	.object({
		username: UsernameSchema,
		name: NameSchema,
		agreeToTermsOfServiceAndPrivacyPolicy: z
			.union([z.boolean(), z.string()])
			.transform((val) => {
				if (typeof val === 'string') {
					return val === 'on' || val === 'true'
				}
				return Boolean(val)
			})
			.refine((val) => val === true, {
				message: 'You must agree to the terms of service and privacy policy',
			}),
		remember: z
			.union([z.boolean(), z.string()])
			.optional()
			.transform((val) => {
				if (typeof val === 'string') {
					return val === 'on' || val === 'true'
				}
				return Boolean(val)
			}),
		redirectTo: z.string().optional(),
	})
	.and(PasswordAndConfirmPasswordSchema)

async function requireOnboardingEmail(request: Request) {
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const email = verifySession.get(onboardingEmailSessionKey)
	if (typeof email !== 'string' || !email) {
		throw new Error('No onboarding email found in session')
	}
	return email
}

export async function action({ request }: Route.ActionArgs) {
	try {
		const formData = await request.formData()

		let email: string
		try {
			email = await requireOnboardingEmail(request)
		} catch {
			return data(
				{
					success: false,
					error: 'no_verification_session',
					message:
						'No verification session found. Please start the signup process again.',
				},
				{ status: 400 },
			)
		}

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
			schema: OnboardingFormSchema.superRefine(async (data, ctx) => {
				const [existingUser] = await db
					.select({ id: User.id })
					.from(User)
					.where(eq(User.username, data.username))
					.limit(1)
				if (existingUser) {
					ctx.addIssue({
						path: ['username'],
						code: z.ZodIssueCode.custom,
						message: 'A user already exists with this username',
					})
					return
				}

				if (process.env.NODE_ENV !== 'test') {
					const isCommonPassword = await checkIsCommonPassword(data.password)
					if (isCommonPassword) {
						ctx.addIssue({
							path: ['password'],
							code: z.ZodIssueCode.custom,
							message:
								'This password is commonly used and not secure. Please choose a different password.',
						})
						return
					}
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

		const { username, name, password } = submission.value

		// Create the user account
		const session = await signup({
			email,
			username,
			name,
			password,
			request,
		})

		// Use shared helper to create authenticated session response
		const response = await createAuthenticatedSessionResponse(
			session.userId,
			request,
		)

		if (!response.success) {
			return data(response, { status: 400 })
		}

		return data(response)
	} catch (error) {
		console.error('Onboarding action error:', error)
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

export async function loader() {
	return data(
		{
			success: false,
			error: 'method_not_allowed',
			message: 'Use POST method for onboarding',
		},
		{ status: 405 },
	)
}
