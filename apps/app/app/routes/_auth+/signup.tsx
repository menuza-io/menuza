import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { Trans, t } from '@lingui/macro'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { verifySessionStorage, requireAnonymous } from '@repo/auth'
import { useIsPending } from '@repo/common'
import { brand, getPageTitle } from '@repo/config/brand'
import { db, eq, User } from '@repo/database'
import { sendEmail, SignupEmail } from '@repo/email'
import { checkHoneypot, validateEmailAddress } from '@repo/security'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Field, FieldLabel, FieldError, FieldGroup } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { StatusButton } from '@repo/ui/status-button'
import { EmailSchema } from '@repo/validation'
import { data, redirect, Form, useSearchParams, Link } from 'react-router'
import { HoneypotInputs } from 'remix-utils/honeypot/react'
import { z } from 'zod'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	ErrorList,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'
import {
	ProviderConnectionForm,
	useConfiguredProviders,
} from '#app/utils/connections.tsx'
import { type Route } from './+types/signup.ts'
import { onboardingInviteTokenSessionKey } from './onboarding'
import { prepareVerification } from './verify.server.tsx'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

const SignupSchema = z.object({
	email: EmailSchema,
})

// Signup is protected by the server-level rate limiter (10 requests/min for
// paths including /signup - see apps/app/server/index.ts). Bot detection and
// disposable/invalid email checks used to come from Arcjet; the email checks
// are replaced below by an in-repo validator.

export async function loader({ request }: Route.LoaderArgs) {
	await requireAnonymous(request)

	// Check for invite token in session
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const inviteToken = verifySession.get(onboardingInviteTokenSessionKey)

	return { inviteToken: typeof inviteToken === 'string' ? inviteToken : null }
}

export async function action(args: Route.ActionArgs) {
	const formData = await args.request.formData()

	await checkHoneypot(formData)

	const submission = await parseWithZod(formData, {
		schema: SignupSchema.superRefine(async (fields, ctx) => {
			// existingUser check moved to action to prevent email enumeration.
			// Block disposable/invalid/no-MX-record email addresses, using the
			// already Zod-validated (and length-bounded) email rather than the
			// raw form value. The MX lookup is skipped in test/mocked
			// environments so tests don't depend on real DNS access.
			const checkMx =
				process.env.NODE_ENV !== 'test' && process['env'].MOCKS !== 'true'
			const emailValidation = await validateEmailAddress(fields.email, {
				checkMx,
			})

			if (!emailValidation.isValid) {
				const errorMessage =
					emailValidation.reason === 'DISPOSABLE'
						? 'Disposable email addresses are not allowed'
						: 'Invalid email address'

				ctx.addIssue({
					path: ['email'],
					code: z.ZodIssueCode.custom,
					message: errorMessage,
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
	const { email } = submission.value
	const [existingUser] = await db
		.select({ id: User.id })
		.from(User)
		.where(eq(User.email, email))
		.limit(1)

	const { verifyUrl, redirectTo, otp } = await prepareVerification({
		period: 10 * 60,
		request: args.request,
		type: 'onboarding',
		target: email,
	})

	let response
	if (existingUser) {
		// Send a generic email indicating the account already exists
		response = await sendEmail({
			to: email,
			subject: brand.email.welcome,
			html: '<p>You recently attempted to sign up for an account with this email address, but an account already exists. Please log in instead.</p>',
			text: 'You recently attempted to sign up for an account with this email address, but an account already exists. Please log in instead.',
		})
	} else {
		response = await sendEmail({
			to: email,
			subject: brand.email.welcome,
			react: <SignupEmail onboardingUrl={verifyUrl.toString()} otp={otp} />,
		})
	}

	if (response.status === 'success') {
		return redirect(redirectTo.toString())
	} else {
		return data(
			{
				result: submission.reply({ formErrors: [response.error.message] }),
			},
			{
				status: 500,
			},
		)
	}
}

export const meta: Route.MetaFunction = () => {
	return [{ title: getPageTitle('Sign Up') }]
}

export default function SignupRoute({
	actionData,
	loaderData,
}: Route.ComponentProps) {
	const isPending = useIsPending()
	const [searchParams] = useSearchParams()
	const redirectTo = searchParams.get('redirectTo')
	const inviteToken = loaderData?.inviteToken
	const configuredProviders = useConfiguredProviders()

	const [form, fields] = useForm({
		id: 'signup-form',
		constraint: getZodConstraint(SignupSchema),
		lastResult: actionData?.result,
		onValidate({ formData }) {
			const result = parseWithZod(formData, { schema: SignupSchema })
			return result
		},
		shouldRevalidate: 'onBlur',
	})

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-xl">
					{inviteToken ? (
						<Trans>Join organization</Trans>
					) : (
						<Trans>Create an account</Trans>
					)}
				</CardTitle>
				<CardDescription>
					{inviteToken ? (
						<Trans>Complete your signup to join the organization</Trans>
					) : (
						<Trans>Sign up with your social account or email</Trans>
					)}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="grid gap-6">
					{/* Social Signup Buttons */}
					{configuredProviders.length > 0 ? (
						<>
							<div className="flex flex-col gap-4">
								{configuredProviders.map((providerName) => (
									<ProviderConnectionForm
										key={providerName}
										type="Signup"
										providerName={providerName}
										redirectTo={redirectTo}
									/>
								))}
							</div>

							{/* Divider */}
							<div className="after:border-border relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t">
								<span className="bg-card text-muted-foreground relative z-10 px-2">
									<Trans>Or continue with</Trans>
								</span>
							</div>
						</>
					) : null}

					{/* Email Signup Form */}
					<Form method="POST" {...getFormProps(form)}>
						<HoneypotInputs />
						<FieldGroup>
							<Field
								data-invalid={fields.email.errors?.length ? true : undefined}
							>
								<FieldLabel htmlFor={fields.email.id}>
									<Trans>Email</Trans>
								</FieldLabel>
								<Input
									{...getInputProps(fields.email, { type: 'email' })}
									autoFocus
									autoComplete="email"
									placeholder={t`m@example.com`}
									required
									aria-invalid={fields.email.errors?.length ? true : undefined}
								/>
								<FieldError
									errors={convertErrorsToFieldFormat(fields.email.errors)}
								/>
							</Field>

							<ErrorList errors={form.errors} id={form.errorId} />

							<StatusButton
								className="w-full"
								status={isPending ? 'pending' : (form.status ?? 'idle')}
								type="submit"
								disabled={isPending}
							>
								<Trans>Sign up</Trans>
							</StatusButton>
						</FieldGroup>
					</Form>
				</div>
			</CardContent>
			<CardFooter className="block rounded-lg p-4 text-center text-sm">
				<Trans>Already have an account?</Trans>{' '}
				<Link
					to={
						redirectTo
							? `/login?redirectTo=${encodeURIComponent(redirectTo)}`
							: '/login'
					}
					className="font-medium underline underline-offset-4"
				>
					<Trans>Sign in</Trans>
				</Link>
			</CardFooter>
		</Card>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
