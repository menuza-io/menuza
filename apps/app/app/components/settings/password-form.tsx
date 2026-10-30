import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod/v4'
import { Trans, t } from '@lingui/macro'

import { Button } from '@repo/ui/button'
import { Field, FieldLabel, FieldError, FieldGroup } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { StatusButton } from '@repo/ui/status-button'
import {
	PasswordSchema,
	PasswordAndConfirmPasswordSchema,
} from '@repo/validation'
import { useFetcher } from 'react-router'
import { z } from 'zod'
import {
	ErrorList,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'
import { setPasswordActionIntent } from '#app/routes/_app+/security.tsx'
import { changePasswordActionIntent } from './cards/security-card'

export const ChangePasswordSchema = z
	.object({
		currentPassword: PasswordSchema,
		newPassword: PasswordSchema,
		confirmNewPassword: PasswordSchema,
	})
	.superRefine(({ confirmNewPassword, newPassword }, ctx) => {
		if (confirmNewPassword !== newPassword) {
			ctx.addIssue({
				path: ['confirmNewPassword'],
				code: z.ZodIssueCode.custom,
				message: t`The passwords must match`,
			})
		}
	})

export function PasswordForm({
	hasPassword,
	setIsOpen,
}: {
	hasPassword: boolean
	setIsOpen: (open: boolean) => void
}) {
	const fetcher = useFetcher()

	const schema = hasPassword
		? ChangePasswordSchema
		: PasswordAndConfirmPasswordSchema

	const [form, fields] = useForm({
		id: 'password-form',
		constraint: getZodConstraint(schema),
		lastResult: fetcher.data?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema })
		},
	})

	if (fetcher.state === 'idle' && fetcher.data?.status === 'success') {
		setIsOpen(false)
	}

	return (
		<fetcher.Form method="POST" {...getFormProps(form)}>
			<input
				type="hidden"
				name="intent"
				value={
					hasPassword ? changePasswordActionIntent : setPasswordActionIntent
				}
			/>

			<FieldGroup>
				{hasPassword && (
					<Field
						data-invalid={
							fields.currentPassword?.errors?.length ? true : undefined
						}
					>
						<FieldLabel htmlFor={fields.currentPassword.id}>
							<Trans>Current Password</Trans>
						</FieldLabel>
						<Input
							{...getInputProps(fields.currentPassword, { type: 'password' })}
							autoComplete="current-password"
							aria-invalid={
								fields.currentPassword?.errors?.length ? true : undefined
							}
						/>
						<FieldError
							errors={convertErrorsToFieldFormat(
								fields.currentPassword?.errors,
							)}
						/>
					</Field>
				)}

				<Field
					data-invalid={
						(hasPassword ? fields.newPassword : fields.password)?.errors?.length
							? true
							: undefined
					}
				>
					<FieldLabel
						htmlFor={(hasPassword ? fields.newPassword : fields.password).id}
					>
						{hasPassword ? (
							<Trans>New Password</Trans>
						) : (
							<Trans>Password</Trans>
						)}
					</FieldLabel>
					<Input
						{...getInputProps(
							hasPassword ? fields.newPassword : fields.password,
							{
								type: 'password',
							},
						)}
						autoComplete="new-password"
						aria-invalid={
							(hasPassword ? fields.newPassword : fields.password)?.errors
								?.length
								? true
								: undefined
						}
					/>
					<FieldError
						errors={convertErrorsToFieldFormat(
							(hasPassword ? fields.newPassword : fields.password)?.errors,
						)}
					/>
				</Field>

				<Field
					data-invalid={
						(hasPassword ? fields.confirmNewPassword : fields.confirmPassword)
							?.errors?.length
							? true
							: undefined
					}
				>
					<FieldLabel
						htmlFor={
							(hasPassword ? fields.confirmNewPassword : fields.confirmPassword)
								.id
						}
					>
						{hasPassword ? (
							<Trans>Confirm New Password</Trans>
						) : (
							<Trans>Confirm Password</Trans>
						)}
					</FieldLabel>
					<Input
						{...getInputProps(
							hasPassword ? fields.confirmNewPassword : fields.confirmPassword,
							{
								type: 'password',
							},
						)}
						autoComplete="new-password"
						aria-invalid={
							(hasPassword ? fields.confirmNewPassword : fields.confirmPassword)
								?.errors?.length
								? true
								: undefined
						}
					/>
					<FieldError
						errors={convertErrorsToFieldFormat(
							(hasPassword ? fields.confirmNewPassword : fields.confirmPassword)
								?.errors,
						)}
					/>
				</Field>

				<ErrorList id={form.errorId} errors={form.errors} />

				<div className="mt-4 flex justify-end gap-2">
					<Button
						type="button"
						variant="secondary"
						onClick={() => setIsOpen(false)}
					>
						<Trans>Cancel</Trans>
					</Button>
					<StatusButton
						type="submit"
						status={
							fetcher.state !== 'idle' ? 'pending' : (form.status ?? 'idle')
						}
					>
						{hasPassword ? (
							<Trans>Change Password</Trans>
						) : (
							<Trans>Create Password</Trans>
						)}
					</StatusButton>
				</div>
			</FieldGroup>
		</fetcher.Form>
	)
}
