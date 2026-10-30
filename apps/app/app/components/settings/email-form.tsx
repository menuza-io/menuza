import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod/v4'
import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { Field, FieldLabel, FieldError, FieldGroup } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { StatusButton } from '@repo/ui/status-button'
import { EmailSchema } from '@repo/validation'
import { useFetcher } from 'react-router'
import { z } from 'zod'
import {
	ErrorList,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'

import { changeEmailActionIntent } from '#app/routes/_app+/profile.tsx'

export const ChangeEmailSchema = z.object({
	email: EmailSchema,
})

export function EmailChangeForm({
	setIsOpen,
}: {
	setIsOpen: (open: boolean) => void
}) {
	const fetcher = useFetcher()

	const [form, fields] = useForm({
		id: 'change-email-form',
		constraint: getZodConstraint(ChangeEmailSchema),
		lastResult: fetcher.data?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: ChangeEmailSchema })
		},
	})

	if (fetcher.data?.status === 'success') {
		return (
			<div className="flex flex-col gap-4">
				<p className="text-sm">
					A verification email has been sent to{' '}
					<strong>{fetcher.data.verificationInfo.email}</strong>. Please check
					your inbox and follow the instructions to verify your new email
					address.
				</p>
				<p className="text-sm">
					Verification code:{' '}
					<strong>{fetcher.data.verificationInfo.otp}</strong>
				</p>
				<div className="mt-4 flex justify-end">
					<Button onClick={() => setIsOpen(false)}>Close</Button>
				</div>
			</div>
		)
	}

	const formProps = getFormProps(form)

	return (
		<fetcher.Form
			method="POST"
			{...formProps}
			onSubmit={(event) => {
				// The dialog is portaled but still sits inside the profile form in
				// the React tree, so stop the submit from reaching that form's
				// conform handler (it throws on events from another form).
				event.stopPropagation()
				formProps.onSubmit?.(event)
			}}
		>
			<input type="hidden" name="intent" value={changeEmailActionIntent} />
			<FieldGroup>
				<Field data-invalid={fields.email.errors?.length ? true : undefined}>
					<FieldLabel htmlFor={fields.email.id}>
						<Trans>New Email</Trans>
					</FieldLabel>
					<Input
						{...getInputProps(fields.email, { type: 'email' })}
						autoComplete="email"
						aria-invalid={fields.email.errors?.length ? true : undefined}
					/>
					<FieldError
						errors={convertErrorsToFieldFormat(fields.email.errors)}
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
						<Trans>Save</Trans>
					</StatusButton>
				</div>
			</FieldGroup>
		</fetcher.Form>
	)
}
