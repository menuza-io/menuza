import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod/v4'
import { Trans, t } from '@lingui/macro'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import {
	verifySessionStorage,
	checkIsCommonPassword,
	requireAnonymous,
} from '@repo/auth'
import { useIsPending } from '@repo/common'
import { getPageTitle } from '@repo/config/brand'
import { db, eq, Session, User } from '@repo/database'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Field, FieldLabel, FieldError, FieldGroup } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { StatusButton } from '@repo/ui/status-button'
import { PasswordAndConfirmPasswordSchema } from '@repo/validation'
import { data, redirect, Form } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	ErrorList,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'

import { resetUserPassword } from '#app/utils/auth.server.ts'
import { type Route } from './+types/reset-password.ts'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

export const resetPasswordUsernameSessionKey = 'resetPasswordUsername'

const ResetPasswordSchema = PasswordAndConfirmPasswordSchema

async function requireResetPasswordUsername(request: Request) {
	await requireAnonymous(request)
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const resetPasswordUsername = verifySession.get(
		resetPasswordUsernameSessionKey,
	)
	if (typeof resetPasswordUsername !== 'string' || !resetPasswordUsername) {
		throw redirect('/login')
	}
	return resetPasswordUsername
}

export async function loader({ request }: Route.LoaderArgs) {
	const resetPasswordUsername = await requireResetPasswordUsername(request)
	return { resetPasswordUsername }
}

export async function action({ request }: Route.ActionArgs) {
	const resetPasswordUsername = await requireResetPasswordUsername(request)
	const formData = await request.formData()
	const submission = await parseWithZod(formData, {
		schema: ResetPasswordSchema.superRefine(async ({ password }, ctx) => {
			const isCommonPassword = await checkIsCommonPassword(password)
			if (isCommonPassword) {
				ctx.addIssue({
					path: ['password'],
					code: 'custom',
					message: t`Password is too common`,
				})
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
	const { password } = submission.value

	await resetUserPassword({ username: resetPasswordUsername, password })
	const [user] = await db
		.select({ id: User.id })
		.from(User)
		.where(eq(User.username, resetPasswordUsername))
		.limit(1)
	if (user) {
		await db.delete(Session).where(eq(Session.userId, user.id))
	}
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	return redirect('/login', {
		headers: {
			'set-cookie': await verifySessionStorage.destroySession(verifySession),
		},
	})
}

export const meta: Route.MetaFunction = () => {
	return [{ title: getPageTitle('Reset Password') }]
}

export default function ResetPasswordPage({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const isPending = useIsPending()

	const [form, fields] = useForm({
		id: 'reset-password',
		constraint: getZodConstraint(ResetPasswordSchema),
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: ResetPasswordSchema })
		},
		shouldRevalidate: 'onBlur',
	})

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-xl">
					<Trans>Reset Password</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>Hi</Trans>, {loaderData.resetPasswordUsername}.{' '}
					<Trans>Enter your new password below.</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Form method="POST" {...getFormProps(form)}>
					<FieldGroup>
						<Field
							data-invalid={fields.password.errors?.length ? true : undefined}
						>
							<FieldLabel htmlFor={fields.password.id}>
								<Trans>New Password</Trans>
							</FieldLabel>
							<Input
								{...getInputProps(fields.password, { type: 'password' })}
								autoComplete="new-password"
								autoFocus
								placeholder={t`Enter your new password`}
								required
								aria-invalid={fields.password.errors?.length ? true : undefined}
							/>
							<FieldError
								errors={convertErrorsToFieldFormat(fields.password.errors)}
							/>
						</Field>

						<Field
							data-invalid={
								fields.confirmPassword.errors?.length ? true : undefined
							}
						>
							<FieldLabel htmlFor={fields.confirmPassword.id}>
								<Trans>Confirm Password</Trans>
							</FieldLabel>
							<Input
								{...getInputProps(fields.confirmPassword, {
									type: 'password',
								})}
								autoComplete="new-password"
								placeholder={t`Confirm your new password`}
								required
								aria-invalid={
									fields.confirmPassword.errors?.length ? true : undefined
								}
							/>
							<FieldError
								errors={convertErrorsToFieldFormat(
									fields.confirmPassword.errors,
								)}
							/>
						</Field>

						<ErrorList errors={form.errors} id={form.errorId} />

						<StatusButton
							className="w-full"
							status={isPending ? 'pending' : (form.status ?? 'idle')}
							type="submit"
							disabled={isPending}
						>
							<Trans>Reset password</Trans>
						</StatusButton>
					</FieldGroup>
				</Form>
			</CardContent>
		</Card>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
