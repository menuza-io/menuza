import { type Submission } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod'
import { invariant } from '@epic-web/invariant'
import {
	generateTOTP,
	verifySessionStorage,
	verifyTOTP,
	requireUserId,
	validateAndConsumeBackupCode,
} from '@repo/auth'
import { getDomainUrl } from '@repo/common'
import { redirectWithToast } from '@repo/common/toast'
import { brand } from '@repo/config/brand'
import { and, db, eq, User, Verification } from '@repo/database'
import { EmailChangeNoticeEmail, sendEmail } from '@repo/email'
import { data } from 'react-router'
import { z } from 'zod'
import {
	newEmailAddressSessionKey,
	twoFAVerificationType,
	type twoFAVerifyVerificationType,
} from '../_app+/security.tsx'
import {
	handleVerification as handleLoginTwoFactorVerification,
	shouldRequestTwoFA,
} from './login.server.ts'
import { handleVerification as handleOnboardingVerification } from './onboarding.server.ts'
import { handleVerification as handleResetPasswordVerification } from './reset-password.server.ts'
import {
	VerifySchema,
	codeQueryParam,
	redirectToQueryParam,
	targetQueryParam,
	typeQueryParam,
	type VerificationTypes,
} from './verify.tsx'

export async function handleChangeEmailVerification({
	request,
	submission,
}: VerifyFunctionArgs) {
	await requireRecentVerification(request)
	invariant(
		submission.status === 'success',
		'Submission should be successful by now',
	)

	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const newEmail = verifySession.get(newEmailAddressSessionKey)
	if (!newEmail) {
		return data(
			{
				result: submission.reply({
					formErrors: [
						'You must submit the code on the same device that requested the email change.',
					],
				}),
			},
			{ status: 400 },
		)
	}
	const [preUpdateUser] = await db
		.select({ email: User.email })
		.from(User)
		.where(eq(User.id, submission.value.target))
		.limit(1)
	if (!preUpdateUser) throw new Response('User not found', { status: 404 })
	const [user] = await db
		.update(User)
		.set({ email: newEmail })
		.where(eq(User.id, submission.value.target))
		.returning({ id: User.id, email: User.email, username: User.username })
	if (!user) throw new Response('User not found', { status: 404 })

	void sendEmail({
		to: preUpdateUser.email,
		subject: `${brand.name} email changed`,
		react: <EmailChangeNoticeEmail userId={user.id} />,
	})

	return redirectWithToast(
		'/settings/profile',
		{
			title: 'Email Changed',
			type: 'success',
			description: `Your email has been changed to ${user.email}`,
		},
		{
			headers: {
				'set-cookie': await verifySessionStorage.destroySession(verifySession),
			},
		},
	)
}

export type VerifyFunctionArgs = {
	request: Request
	submission: Submission<
		z.input<typeof VerifySchema>,
		string[],
		z.output<typeof VerifySchema>
	>
	body: FormData | URLSearchParams
}

export function getRedirectToUrl({
	request,
	type,
	target,
	redirectTo,
}: {
	request: Request
	type: VerificationTypes
	target: string
	redirectTo?: string
}) {
	const redirectToUrl = new URL(`${getDomainUrl(request)}/verify`)
	redirectToUrl.searchParams.set(typeQueryParam, type)
	redirectToUrl.searchParams.set(targetQueryParam, target)
	if (redirectTo) {
		redirectToUrl.searchParams.set(redirectToQueryParam, redirectTo)
	}
	return redirectToUrl
}

export async function requireRecentVerification(request: Request) {
	const userId = await requireUserId(request)
	const shouldReverify = await shouldRequestTwoFA(request)
	if (shouldReverify) {
		const reqUrl = new URL(request.url)
		const redirectUrl = getRedirectToUrl({
			request,
			target: userId,
			type: twoFAVerificationType,
			redirectTo: reqUrl.pathname + reqUrl.search,
		})
		throw await redirectWithToast(redirectUrl.toString(), {
			title: 'Please Reverify',
			description: 'Please reverify your account before proceeding',
		})
	}
}

export async function prepareVerification({
	period,
	request,
	type,
	target,
}: {
	period: number
	request: Request
	type: VerificationTypes
	target: string
}) {
	const verifyUrl = getRedirectToUrl({ request, type, target })
	const redirectTo = new URL(verifyUrl.toString())

	const { otp, ...verificationConfig } = await generateTOTP({
		algorithm: 'SHA-256',
		// Leaving off 0, O, and I on purpose to avoid confusing users.
		charSet: 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789',
		period,
	})
	const verificationData = {
		type,
		target,
		...verificationConfig,
		expiresAt: new Date(Date.now() + verificationConfig.period * 1000),
	}
	await db
		.insert(Verification)
		.values(verificationData)
		.onConflictDoUpdate({
			target: [Verification.target, Verification.type],
			set: verificationData,
		})

	// add the otp to the url we'll email the user.
	verifyUrl.searchParams.set(codeQueryParam, otp)

	return { otp, redirectTo, verifyUrl }
}

export async function checkCodeValidity({
	code,
	type,
	target,
}: {
	code: string
	type: VerificationTypes | typeof twoFAVerifyVerificationType
	target: string
}): Promise<'valid' | 'expired' | 'invalid'> {
	const [verification] = await db
		.select({
			algorithm: Verification.algorithm,
			secret: Verification.secret,
			period: Verification.period,
			charSet: Verification.charSet,
			expiresAt: Verification.expiresAt,
		})
		.from(Verification)
		.where(and(eq(Verification.target, target), eq(Verification.type, type)))
		.limit(1)
	if (!verification) return 'invalid'
	const result = await verifyTOTP({
		otp: code,
		...verification,
	})
	if (result) {
		if (verification.expiresAt && verification.expiresAt < new Date()) {
			return 'expired'
		}
		return 'valid'
	}

	// For 2FA verification, also try backup codes as fallback
	if (type === twoFAVerificationType) {
		const backupCodeValid = await validateAndConsumeBackupCode(target, code)
		if (backupCodeValid) return 'valid'
	}

	if (verification.expiresAt && verification.expiresAt < new Date()) {
		return 'expired'
	}

	return 'invalid'
}

export async function isCodeValid(args: {
	code: string
	type: VerificationTypes | typeof twoFAVerifyVerificationType
	target: string
}) {
	const status = await checkCodeValidity(args)
	return status === 'valid'
}

export async function validateRequest(
	request: Request,
	body: URLSearchParams | FormData,
) {
	const submission = await parseWithZod(body, {
		schema: VerifySchema.superRefine(async (data, ctx) => {
			const status = await checkCodeValidity({
				code: data[codeQueryParam],
				type: data[typeQueryParam],
				target: data[targetQueryParam],
			})
			if (status !== 'valid') {
				ctx.addIssue({
					path: ['code'],
					code: z.ZodIssueCode.custom,
					message:
						status === 'expired'
							? 'This code has expired. Please request a new one.'
							: 'Invalid code',
				})
				return
			}
		}),
		async: true,
	})

	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { value: submissionValue } = submission

	async function deleteVerification() {
		await db
			.delete(Verification)
			.where(
				and(
					eq(Verification.target, submissionValue[targetQueryParam]),
					eq(Verification.type, submissionValue[typeQueryParam]),
				),
			)
	}

	switch (submissionValue[typeQueryParam]) {
		case 'reset-password': {
			await deleteVerification()
			return handleResetPasswordVerification({ request, body, submission })
		}
		case 'onboarding': {
			await deleteVerification()
			return handleOnboardingVerification({ request, body, submission })
		}
		case 'change-email': {
			await deleteVerification()
			return handleChangeEmailVerification({ request, body, submission })
		}
		case '2fa': {
			return handleLoginTwoFactorVerification({ request, body, submission })
		}
	}
}
