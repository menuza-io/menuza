import {
	getFormProps,
	getInputProps,
	useForm,
	type SubmissionResult,
} from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { Trans, t } from '@lingui/macro'
import {
	authSessionStorage,
	verifySessionStorage,
	sessionKey,
	requireAnonymous,
	ProviderNameSchema,
} from '@repo/auth'
import { useIsPending } from '@repo/common'
import { redirectWithToast } from '@repo/common/toast'
import { getPageTitle } from '@repo/config/brand'
import { db, eq, User } from '@repo/database'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Field, FieldLabel, FieldError, FieldGroup } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { StatusButton } from '@repo/ui/status-button'
import { NameSchema, UsernameSchema } from '@repo/validation'
import {
	redirect,
	data,
	type Params,
	Form,
	useSearchParams,
} from 'react-router'
import { z } from 'zod'
import {
	ErrorList,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'

import { signupWithConnection } from '#app/utils/auth.server.ts'
import { type Route } from './+types/onboarding_.$provider.ts'
import {
	onboardingEmailSessionKey,
	onboardingInviteTokenSessionKey,
} from './onboarding'

export const providerIdKey = 'providerId'
export const prefilledProfileKey = 'prefilledProfile'

async function requireData({
	request,
	params,
}: {
	request: Request
	params: Params
}) {
	await requireAnonymous(request)
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const email = verifySession.get(onboardingEmailSessionKey)
	const providerId = verifySession.get(providerIdKey)
	const result = z
		.object({
			email: z.string(),
			providerName: ProviderNameSchema,
			providerId: z.string().or(z.number()),
		})
		.safeParse({ email, providerName: params.provider, providerId })
	if (result.success) {
		return result.data
	} else {
		console.error(result.error)
		throw redirect('/signup')
	}
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const { email } = await requireData({ request, params })

	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const prefilledProfile = verifySession.get(prefilledProfileKey)

	return {
		email,
		status: 'idle',
		submission: {
			initialValue: prefilledProfile ?? {},
		} as SubmissionResult,
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const SignupFormSchema = z.object({
		imageUrl: z.string().optional(),
		username: UsernameSchema,
		name: NameSchema,
		agreeToTermsOfServiceAndPrivacyPolicy: z.boolean({
			required_error: t`You must agree to the terms of service and privacy policy`,
		}),
		remember: z.boolean().optional(),
		redirectTo: z.string().optional(),
	})
	const { email, providerId, providerName } = await requireData({
		request,
		params,
	})
	const formData = await request.formData()
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const inviteToken = verifySession.get(onboardingInviteTokenSessionKey)

	const submission = await parseWithZod(formData, {
		schema: SignupFormSchema.superRefine(async (data, ctx) => {
			const [existingUser] = await db
				.select({ id: User.id })
				.from(User)
				.where(eq(User.username, data.username))
				.limit(1)
			if (existingUser) {
				ctx.addIssue({
					path: ['username'],
					code: z.ZodIssueCode.custom,
					message: t`A user already exists with this username`,
				})
				return
			}
		}).transform(async (data) => {
			const session = await signupWithConnection({
				request,
				...data,
				email,
				providerId: String(providerId),
				providerName,
			})
			return { ...data, session }
		}),
		async: true,
	})

	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { session, remember } = submission.value

	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	authSession.set(sessionKey, session.id)
	const headers = new Headers()
	headers.append(
		'set-cookie',
		await authSessionStorage.commitSession(authSession, {
			expires: remember ? session.expirationDate : undefined,
		}),
	)
	headers.append(
		'set-cookie',
		await verifySessionStorage.destroySession(verifySession),
	)

	if (typeof inviteToken === 'string') {
		try {
			const { createInvitationFromLink } =
				await import('#app/utils/organization/invitation.server.ts')
			const invitation = await createInvitationFromLink(inviteToken, email)
			if (!invitation) throw new Error('Invitation could not be created')

			const inviterName =
				invitation.inviter?.name || invitation.inviter?.email || 'Someone'
			const organizationName = invitation.organization.name
			return redirectWithToast(
				'/organizations',
				{
					title: t`Welcome!`,
					description: t`Thanks for signing up! ${inviterName} has invited you to join ${organizationName}. Review the invitation below.`,
				},
				{ headers },
			)
		} catch (error) {
			console.error('Error processing invite link during social signup:', error)
		}
	}

	return redirectWithToast(
		'/organizations',
		{ title: t`Welcome`, description: t`Thanks for signing up!` },
		{ headers },
	)
}

export const meta: Route.MetaFunction = () => {
	return [{ title: getPageTitle('Setup Account') }]
}

export default function OnboardingProviderRoute({
	loaderData: { email, submission },
	actionData,
}: Route.ComponentProps) {
	const isPending = useIsPending()
	const [searchParams] = useSearchParams()
	const redirectTo = searchParams.get('redirectTo')

	const SignupFormSchema = z.object({
		imageUrl: z.string().optional(),
		username: UsernameSchema,
		name: NameSchema,
		agreeToTermsOfServiceAndPrivacyPolicy: z.boolean({
			required_error: t`You must agree to the terms of service and privacy policy`,
		}),
		remember: z.boolean().optional(),
		redirectTo: z.string().optional(),
	})

	const [form, fields] = useForm({
		id: 'onboarding-provider-form',
		constraint: getZodConstraint(SignupFormSchema),
		lastResult: actionData?.result ?? submission,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: SignupFormSchema })
		},
		shouldRevalidate: 'onBlur',
	})

	const { type: _agreeType, ...agreeCheckboxProps } = getInputProps(
		fields.agreeToTermsOfServiceAndPrivacyPolicy,
		{ type: 'checkbox' },
	)

	const { type: _rememberType, ...rememberCheckboxProps } = getInputProps(
		fields.remember,
		{ type: 'checkbox' },
	)

	return (
		<div
			className="flex min-h-screen items-center justify-center bg-gradient-to-br from-purple-400 via-pink-500 to-red-500 p-4"
			style={{
				backgroundImage: `url('/assets/images/background_1.webp')`,
				backgroundSize: 'cover',
				backgroundPosition: 'center',
				backgroundRepeat: 'no-repeat',
			}}
		>
			<div className="w-full max-w-md">
				<div className="flex flex-col gap-6">
					<Card>
						<CardHeader className="text-center">
							<CardTitle className="text-xl">
								<Trans>Complete your profile</Trans>
							</CardTitle>
							<CardDescription>
								<Trans>
									Hi {email}, just a few more details to get started.
								</Trans>
							</CardDescription>
						</CardHeader>
						<CardContent>
							<Form method="POST" {...getFormProps(form)}>
								<FieldGroup>
									{fields.imageUrl.initialValue ? (
										<div className="flex flex-col items-center justify-center gap-4">
											<img
												src={fields.imageUrl.initialValue}
												alt={t`Profile`}
												className="size-24 rounded-full"
												width={96}
												height={96}
											/>
											<p className="text-muted-foreground text-sm">
												<Trans>You can change your photo later</Trans>
											</p>
											<input
												{...getInputProps(fields.imageUrl, { type: 'hidden' })}
											/>
										</div>
									) : null}

									<Field
										data-invalid={
											fields.username.errors?.length ? true : undefined
										}
									>
										<FieldLabel htmlFor={fields.username.id}>
											<Trans>Username</Trans>
										</FieldLabel>
										<Input
											{...getInputProps(fields.username, { type: 'text' })}
											autoComplete="username"
											className="lowercase"
											placeholder={t`Enter your username`}
											required
											aria-invalid={
												fields.username.errors?.length ? true : undefined
											}
										/>
										<FieldError
											errors={convertErrorsToFieldFormat(
												fields.username.errors,
											)}
										/>
									</Field>

									<Field
										data-invalid={fields.name.errors?.length ? true : undefined}
									>
										<FieldLabel htmlFor={fields.name.id}>
											<Trans>Full Name</Trans>
										</FieldLabel>
										<Input
											{...getInputProps(fields.name, { type: 'text' })}
											autoComplete="name"
											placeholder={t`Enter your full name`}
											required
											aria-invalid={
												fields.name.errors?.length ? true : undefined
											}
										/>
										<FieldError
											errors={convertErrorsToFieldFormat(fields.name.errors)}
										/>
									</Field>

									<FieldGroup>
										<Field orientation="horizontal">
											<Checkbox
												{...agreeCheckboxProps}
												id={fields.agreeToTermsOfServiceAndPrivacyPolicy.id}
											/>
											<FieldLabel
												htmlFor={
													fields.agreeToTermsOfServiceAndPrivacyPolicy.id
												}
												className="font-normal"
											>
												<Trans>
													I agree to the Terms of Service and Privacy Policy
												</Trans>
											</FieldLabel>
										</Field>
										<FieldError
											errors={convertErrorsToFieldFormat(
												fields.agreeToTermsOfServiceAndPrivacyPolicy.errors,
											)}
										/>

										<Field orientation="horizontal">
											<Checkbox
												{...rememberCheckboxProps}
												id={fields.remember.id}
											/>
											<FieldLabel
												htmlFor={fields.remember.id}
												className="font-normal"
											>
												<Trans>Remember me</Trans>
											</FieldLabel>
										</Field>
									</FieldGroup>

									{redirectTo ? (
										<input type="hidden" name="redirectTo" value={redirectTo} />
									) : null}

									<ErrorList errors={form.errors} id={form.errorId} />

									<StatusButton
										className="w-full"
										status={isPending ? 'pending' : (form.status ?? 'idle')}
										type="submit"
										disabled={isPending}
									>
										<Trans>Create account</Trans>
									</StatusButton>
								</FieldGroup>
							</Form>
						</CardContent>
					</Card>
					<div className="text-center text-xs text-balance text-white/80 *:[a]:underline *:[a]:underline-offset-4 *:[a]:hover:text-white">
						<Trans>
							By creating an account, you agree to our{' '}
							<a href="#">Terms of Service</a> and{' '}
							<a href="#">Privacy Policy</a>.
						</Trans>
					</div>
				</div>
			</div>
		</div>
	)
}
