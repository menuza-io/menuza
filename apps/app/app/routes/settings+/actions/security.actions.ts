import { parseWithZod } from '@conform-to/zod/v4'
import {
	verifyUserPassword,
	getPasswordHash,
	checkIsCommonPassword,
	authSessionStorage,
	sessionKey,
	generateBackupCodes,
	deleteBackupCodes,
} from '@repo/auth'
import {
	and,
	db,
	eq,
	ne,
	Password,
	Session,
	Verification,
} from '@repo/database'
import {
	PasswordAndConfirmPasswordSchema,
	PasswordSchema,
} from '@repo/validation'
import { z } from 'zod'

import {
	twoFAVerificationType,
	twoFAVerifyVerificationType,
} from '#app/routes/_app+/security.tsx'
import { isCodeValid } from '#app/routes/_auth+/verify.server.tsx'

export const ChangePasswordSchema = z
	.object({
		currentPassword: z.string().min(1, 'Current password is required'),
		newPassword: PasswordSchema,
		confirmNewPassword: z.string().min(1, 'Confirm your new password'),
	})
	.refine((data) => data.newPassword === data.confirmNewPassword, {
		message: 'Passwords do not match',
		path: ['confirmNewPassword'],
	})

export const Enable2FASchema = z.object({
	code: z.string().min(6, { message: 'Code is required' }),
})

type SecurityActionArgs = {
	userId: string
	formData: FormData
	request?: Request
}

export async function changePasswordAction({
	userId,
	formData,
	request,
}: SecurityActionArgs) {
	const submission = await parseWithZod(formData, {
		async: true,
		schema: ChangePasswordSchema.superRefine(
			async ({ currentPassword, newPassword }, ctx) => {
				if (currentPassword && newPassword) {
					const user = await verifyUserPassword({ id: userId }, currentPassword)
					if (!user) {
						ctx.addIssue({
							path: ['currentPassword'],
							code: z.ZodIssueCode.custom,
							message: 'Incorrect password.',
						})
					}
					const isCommonPassword = await checkIsCommonPassword(newPassword)
					if (isCommonPassword) {
						ctx.addIssue({
							path: ['newPassword'],
							code: 'custom',
							message: 'Password is too common',
						})
					}
				}
			},
		),
	})

	if (submission.status !== 'success') {
		return Response.json(
			{
				result: submission.reply({
					hideFields: ['currentPassword', 'newPassword', 'confirmNewPassword'],
				}),
			},
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { newPassword } = submission.value
	const newPasswordHash = await getPasswordHash(newPassword)

	await db
		.insert(Password)
		.values({ userId, hash: newPasswordHash })
		.onConflictDoUpdate({
			target: Password.userId,
			set: { hash: newPasswordHash },
		})

	// Invalidate all other sessions except the current one
	if (request) {
		const authSession = await authSessionStorage.getSession(
			request.headers.get('cookie'),
		)
		const currentSessionId = authSession.get(sessionKey)
		if (currentSessionId) {
			await db
				.delete(Session)
				.where(
					and(eq(Session.userId, userId), ne(Session.id, currentSessionId)),
				)
		}
	}

	return Response.json({
		status: 'success',
		result: submission.reply(),
	})
}

export async function setPasswordAction({
	userId,
	formData,
	request,
}: SecurityActionArgs) {
	const submission = await parseWithZod(formData, {
		async: true,
		schema: PasswordAndConfirmPasswordSchema.superRefine(
			async ({ password }, ctx) => {
				const isCommonPassword = await checkIsCommonPassword(password)
				if (isCommonPassword) {
					ctx.addIssue({
						path: ['password'],
						code: 'custom',
						message: 'Password is too common',
					})
				}
			},
		),
	})

	if (submission.status !== 'success') {
		return Response.json(
			{
				result: submission.reply({
					hideFields: ['password', 'confirmPassword'],
				}),
			},
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { password } = submission.value

	await db.insert(Password).values({
		userId,
		hash: await getPasswordHash(password),
	})

	// Invalidate all other sessions except the current one
	if (request) {
		const authSession = await authSessionStorage.getSession(
			request.headers.get('cookie'),
		)
		const currentSessionId = authSession.get(sessionKey)
		if (currentSessionId) {
			await db
				.delete(Session)
				.where(
					and(eq(Session.userId, userId), ne(Session.id, currentSessionId)),
				)
		}
	}

	return Response.json({
		status: 'success',
		result: submission.reply(),
	})
}

export async function enable2FAAction({
	formData,
	userId,
}: SecurityActionArgs) {
	const submission = await parseWithZod(formData, {
		schema: Enable2FASchema.superRefine(async (data, ctx) => {
			const codeIsValid = await isCodeValid({
				code: data.code,
				type: twoFAVerifyVerificationType,
				target: userId,
			})
			if (!codeIsValid) {
				ctx.addIssue({
					path: ['code'],
					code: z.ZodIssueCode.custom,
					message: `Invalid code`,
				})
				return z.NEVER
			}
		}),
		async: true,
	})

	if (submission.status !== 'success') {
		return Response.json(
			{ result: submission.reply(), status: 'error' },
			{ status: 400 },
		)
	}

	await db
		.update(Verification)
		.set({ type: twoFAVerificationType, expiresAt: null })
		.where(
			and(
				eq(Verification.target, userId),
				eq(Verification.type, twoFAVerifyVerificationType),
			),
		)

	return Response.json({ status: 'success' })
}

export const Disable2FASchema = z.object({
	code: z.string().min(1, 'Code is required'),
})

export async function disable2FAAction({
	formData,
	userId,
}: SecurityActionArgs) {
	const submission = await parseWithZod(formData, {
		schema: Disable2FASchema.superRefine(async (data, ctx) => {
			const codeIsValid = await isCodeValid({
				code: data.code,
				type: twoFAVerificationType,
				target: userId,
			})
			if (!codeIsValid) {
				ctx.addIssue({
					path: ['code'],
					code: z.ZodIssueCode.custom,
					message: `Invalid code`,
				})
				return z.NEVER
			}
		}),
		async: true,
	})

	if (submission.status !== 'success') {
		return Response.json(
			{ result: submission.reply(), status: 'error' },
			{ status: 400 },
		)
	}

	// Delete 2FA verification
	await db
		.delete(Verification)
		.where(
			and(
				eq(Verification.target, userId),
				eq(Verification.type, twoFAVerificationType),
			),
		)

	// Also delete any backup codes
	await deleteBackupCodes(userId)

	return Response.json({ status: 'success' })
}

/**
 * Generate new backup codes for a user
 * This will replace any existing backup codes
 */
export async function generateBackupCodesAction({
	userId,
}: SecurityActionArgs) {
	// Verify user has 2FA enabled
	const [verification] = await db
		.select()
		.from(Verification)
		.where(
			and(
				eq(Verification.target, userId),
				eq(Verification.type, twoFAVerificationType),
			),
		)
		.limit(1)

	if (!verification) {
		return Response.json(
			{
				status: 'error',
				message: '2FA must be enabled to generate backup codes',
			},
			{ status: 400 },
		)
	}

	const codes = await generateBackupCodes(userId)

	return Response.json({
		status: 'success',
		codes,
	})
}

/**
 * Regenerate backup codes - same as generate but explicit intent
 */
export async function regenerateBackupCodesAction({
	userId,
}: SecurityActionArgs) {
	return generateBackupCodesAction({ userId, formData: new FormData() })
}
