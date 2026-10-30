import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod/v4'
import { Trans, t } from '@lingui/macro'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { brand, getPageTitle } from '@repo/config/brand'
import { db, eq, or, User } from '@repo/database'
import { ForgotPasswordEmail, sendEmail } from '@repo/email'
import {
	checkHoneypot,
	getClientIp,
	validateEmailAddress,
} from '@repo/security'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Field, FieldLabel, FieldError, FieldGroup } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { StatusButton } from '@repo/ui/status-button'
import { EmailSchema, UsernameSchema } from '@repo/validation'
import { data, redirect, Link, Form, useActionData } from 'react-router'
import { HoneypotInputs } from 'remix-utils/honeypot/react'
import { z } from 'zod'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	ErrorList,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'
import {
	checkRateLimit,
	createRateLimitResponse,
} from '#app/utils/rate-limit.server.ts'
import { type Route } from './+types/forgot-password.ts'
import { prepareVerification } from './verify.server.tsx'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

const ForgotPasswordSchema = z.object({
	usernameOrEmail: z.union([EmailSchema, UsernameSchema]),
})

// Forgot-password is the one auth form the server-level rate limiter
// (apps/app/server/index.ts) does not cover as tightly as it should - it
// falls under the general 100/min tier there. Arcjet used to enforce a
// stricter 3-requests-per-hour window here; replicate that with the same
// DB-backed limiter used elsewhere in this app (see #app/utils/rate-limit.server.ts).
const isDev = process.env.NODE_ENV !== 'production'
const FORGOT_PASSWORD_RATE_LIMIT = {
	scope: 'auth-forgot-password',
	maxRequests: isDev ? 1000 : 3,
	windowMs: 60 * 60 * 1000, // 1 hour
}

export async function action({ request }: Route.ActionArgs) {
	const formData = await request.formData()
	await checkHoneypot(formData)

	const clientIp = getClientIp(request)
	const rateLimitCheck = await checkRateLimit(
		{ type: 'ip', value: clientIp },
		FORGOT_PASSWORD_RATE_LIMIT,
	)
	if (!rateLimitCheck.allowed) {
		return createRateLimitResponse(rateLimitCheck.resetAt)
	}

	// Parse and length-bound the submitted value with Zod *before* running any
	// additional checks on it - `EmailSchema`/`UsernameSchema` cap it at
	// 100/20 characters respectively, so an attacker can't hand an unbounded
	// string to the disposable/MX validator below.
	const submission = await parseWithZod(formData, {
		schema: ForgotPasswordSchema,
	})
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}
	const { usernameOrEmail } = submission.value

	// Block disposable/invalid/no-MX-record email addresses (mirrors Arcjet's
	// validateEmail rule). Skip the DNS-dependent MX check in test/mocked
	// environments. `usernameOrEmail` may be a username rather than an email;
	// only validate when it looks like an email address.
	if (usernameOrEmail.includes('@')) {
		const checkMx =
			process.env.NODE_ENV !== 'test' && process['env'].MOCKS !== 'true'
		const emailValidation = await validateEmailAddress(usernameOrEmail, {
			checkMx,
		})
		if (!emailValidation.isValid) {
			return data(
				{ result: null },
				{ status: 400, statusText: 'Invalid email address' },
			)
		}
	}

	const [user] = await db
		.select({ id: User.id, email: User.email, username: User.username })
		.from(User)
		.where(
			or(eq(User.email, usernameOrEmail), eq(User.username, usernameOrEmail)),
		)
		.limit(1)

	if (user) {
		const { verifyUrl, redirectTo, otp } = await prepareVerification({
			period: 10 * 60,
			request,
			type: 'reset-password',
			target: usernameOrEmail,
		})

		const response = await sendEmail({
			to: user.email,
			subject: brand.email.passwordReset,
			react: (
				<ForgotPasswordEmail onboardingUrl={verifyUrl.toString()} otp={otp} />
			),
		})

		if (response.status === 'success') {
			return redirect(redirectTo.toString())
		} else {
			return data(
				{ result: submission.reply({ formErrors: [response.error.message] }) },
				{ status: 500 },
			)
		}
	}

	// Just generate a fake redirect to not leak the account's existence
	const { redirectTo } = await prepareVerification({
		period: 10 * 60,
		request,
		type: 'reset-password',
		target: usernameOrEmail,
	})

	return redirect(redirectTo.toString())
}

export const meta: Route.MetaFunction = () => {
	return [{ title: getPageTitle('Password Recovery') }]
}

export default function ForgotPasswordRoute() {
	const actionData = useActionData<typeof action>() as {
		error?: string
		error_description?: string
		result?: any
	} | null
	const rateLimitError =
		actionData?.error === 'rate_limit_exceeded'
			? actionData.error_description
			: null

	const [form, fields] = useForm({
		id: 'forgot-password-form',
		constraint: getZodConstraint(ForgotPasswordSchema),
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: ForgotPasswordSchema })
		},
		shouldRevalidate: 'onBlur',
	})

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-xl">
					<Trans>Forgot Password</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>No worries, we'll send you reset instructions.</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				{rateLimitError && (
					<div
						role="alert"
						className="border-destructive/50 bg-destructive/10 mb-4 rounded-lg border p-4"
					>
						<div className="text-destructive flex items-center gap-2">
							<Icon name="alert-triangle" className="h-5 w-5" />
							<h3 className="font-semibold">
								<Trans>Too Many Requests</Trans>
							</h3>
						</div>
						<p className="text-destructive/90 mt-2 text-sm">{rateLimitError}</p>
					</div>
				)}

				<Form method="POST" {...getFormProps(form)}>
					<HoneypotInputs />
					<FieldGroup>
						<Field
							data-invalid={
								fields.usernameOrEmail.errors?.length ? true : undefined
							}
						>
							<FieldLabel htmlFor={fields.usernameOrEmail.id}>
								<Trans>Username or Email</Trans>
							</FieldLabel>
							<Input
								{...getInputProps(fields.usernameOrEmail, { type: 'text' })}
								autoFocus
								placeholder={t`Enter your username or email`}
								required
								aria-invalid={
									fields.usernameOrEmail.errors?.length ? true : undefined
								}
							/>
							<FieldError
								errors={convertErrorsToFieldFormat(
									fields.usernameOrEmail.errors,
								)}
							/>
						</Field>

						<ErrorList errors={form.errors} id={form.errorId} />

						<StatusButton
							className="w-full"
							status={form.status ?? 'idle'}
							type="submit"
						>
							<Trans>Send reset instructions</Trans>
						</StatusButton>
					</FieldGroup>
				</Form>
			</CardContent>
			<CardFooter className="block rounded-lg p-4 text-center text-sm">
				<Trans>Remember your password?</Trans>{' '}
				<Link to="/login" className="font-medium underline underline-offset-4">
					<Trans>Back to login</Trans>
				</Link>
			</CardFooter>
		</Card>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
