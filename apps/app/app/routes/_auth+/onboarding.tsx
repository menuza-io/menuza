import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { t, Trans } from '@lingui/macro'
import {
	authSessionStorage,
	verifySessionStorage,
	checkIsCommonPassword,
	requireAnonymous,
	sessionKey,
} from '@repo/auth'
import { useIsPending } from '@repo/common'
import { redirectWithToast } from '@repo/common/toast'
import { getPageTitle } from '@repo/config/brand'
import {
	and,
	db,
	eq,
	isNull,
	Organization,
	OrganizationRole,
	User,
	UserOrganization,
} from '@repo/database'
import { checkHoneypot } from '@repo/security'
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
import {
	NameSchema,
	PasswordAndConfirmPasswordSchema,
	UsernameSchema,
} from '@repo/validation'
import { data, redirect, Form, useSearchParams } from 'react-router'
import { HoneypotInputs } from 'remix-utils/honeypot/react'
import { z } from 'zod'
import {
	ErrorList,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'
import { signup } from '#app/utils/auth.server.ts'
import { getLaunchStatus } from '#app/utils/env.server.ts'
import { updateSeatQuantity } from '#app/utils/payments.server.ts'
import { type Route } from './+types/onboarding.ts'

export const onboardingEmailSessionKey = 'onboardingEmail'
export const onboardingInviteTokenSessionKey = 'onboardingInviteToken'
export const onboardingReferralCodeSessionKey = 'referralCode'

async function requireOnboardingEmail(request: Request) {
	await requireAnonymous(request)
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const email = verifySession.get(onboardingEmailSessionKey)
	if (typeof email !== 'string' || !email) {
		throw redirect('/signup')
	}
	return email
}

async function getOnboardingInviteToken(request: Request) {
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const inviteToken = verifySession.get(onboardingInviteTokenSessionKey)
	return typeof inviteToken === 'string' ? inviteToken : null
}

async function getOnboardingReferralCode(request: Request) {
	const verifySession = await verifySessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const referralCode = verifySession.get(onboardingReferralCodeSessionKey)
	return typeof referralCode === 'string' ? referralCode : null
}

export async function loader({ request }: Route.LoaderArgs) {
	const email = await requireOnboardingEmail(request)
	const inviteToken = await getOnboardingInviteToken(request)
	return { email, inviteToken }
}

export async function action({ request }: Route.ActionArgs) {
	const SignupFormSchema = z
		.object({
			username: UsernameSchema,
			name: NameSchema,
			agreeToTermsOfServiceAndPrivacyPolicy: z.boolean({
				required_error: t`You must agree to the terms of service and privacy policy`,
			}),
			remember: z.boolean().optional(),
			redirectTo: z.string().optional(),
		})
		.and(PasswordAndConfirmPasswordSchema)
	const email = await requireOnboardingEmail(request)
	const inviteToken = await getOnboardingInviteToken(request)
	const formData = await request.formData()
	await checkHoneypot(formData)
	const submission = await parseWithZod(formData, {
		schema: (intent) =>
			SignupFormSchema.superRefine(async (data, ctx) => {
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
				const isCommonPassword = await checkIsCommonPassword(data.password)
				if (isCommonPassword) {
					ctx.addIssue({
						path: ['password'],
						code: 'custom',
						message: t`Password is too common`,
					})
				}
			}).transform(async (data) => {
				if (intent !== null) return { ...data, session: null }

				// Pass the request to the signup function to capture UTM parameters
				const session = await signup({ ...data, email, request })
				return { ...data, session }
			}),
		async: true,
	})

	if (submission.status !== 'success' || !submission.value.session) {
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
	const verifySession = await verifySessionStorage.getSession()
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

	// Check for invite token first
	if (inviteToken) {
		try {
			const { createInvitationFromLink } =
				await import('#app/utils/organization/invitation.server.ts')
			// Create a pending invitation for this user
			const invitation = await createInvitationFromLink(inviteToken, email)
			if (!invitation) throw new Error('Invitation could not be created')

			const inviterName =
				invitation.inviter?.name || invitation.inviter?.email || 'Someone'
			const orgName = invitation.organization.name
			return redirectWithToast(
				'/organizations',
				{
					title: t`Welcome!`,
					description: t`Thanks for signing up! ${inviterName} has invited you to join ${orgName}. Review the invitation below.`,
				},
				{ headers },
			)
		} catch (error) {
			console.error('Error processing invite link during signup:', error)
			// If invite link processing fails, continue with normal flow
		}
	}

	// Check for pending organization invitations and accept them
	try {
		const { acceptInvitationByEmail } =
			await import('#app/utils/organization/invitation.server.ts')
		const invitationResults = await acceptInvitationByEmail(
			email,
			session.userId,
		)

		if (invitationResults.length > 0) {
			const joinedOrganizations = invitationResults.filter(
				(result) => !result.alreadyMember,
			)
			if (joinedOrganizations.length > 0) {
				// If user has pending invitations, redirect to settings/organizations to accept them
				return redirectWithToast(
					'/organizations',
					{
						title: t`Welcome!`,
						description: t`Thanks for signing up! You have pending organization invitations.`,
					},
					{ headers },
				)
			}
		}
	} catch (error) {
		// Don't fail the signup if invitation processing fails
		console.error(
			'Error processing organization invitations during signup:',
			error,
		)
	}

	// Check for organizations with verified domains matching the user's email
	try {
		const emailDomain = email.split('@')[1]
		if (emailDomain) {
			const [organizationsWithMatchingDomain, memberRole] = await Promise.all([
				db
					.select({
						id: Organization.id,
						name: Organization.name,
						slug: Organization.slug,
					})
					.from(Organization)
					.leftJoin(
						UserOrganization,
						and(
							eq(UserOrganization.organizationId, Organization.id),
							eq(UserOrganization.userId, session.userId),
						),
					)
					.where(
						and(
							eq(Organization.verifiedDomain, emailDomain),
							isNull(UserOrganization.userId),
						),
					),
				// Get the default member role
				db
					.select({ id: OrganizationRole.id })
					.from(OrganizationRole)
					.where(
						and(
							eq(OrganizationRole.name, 'member'),
							isNull(OrganizationRole.organizationId),
						),
					)
					.limit(1),
			])

			const memberRoleId = memberRole[0]?.id
			if (organizationsWithMatchingDomain.length > 0 && memberRoleId) {
				// Auto-add user to organizations with matching verified domains
				await db.insert(UserOrganization).values(
					organizationsWithMatchingDomain.map((org) => ({
						userId: session.userId,
						organizationId: org.id,
						organizationRoleId: memberRoleId, // Use proper organization role
					})),
				)

				// Update seat quantity for billing for each organization
				for (const org of organizationsWithMatchingDomain) {
					try {
						await updateSeatQuantity(org.id)
					} catch (error) {
						console.error(
							`Failed to update seat quantity for organization ${org.id} after domain-based auto-join:`,
							error,
						)
					}
				}

				const orgNames = organizationsWithMatchingDomain
					.map((org) => org.name)
					.join(', ')

				// Redirect to organizations page to show the user they've been added
				return redirectWithToast(
					'/organizations',
					{
						title: t`Welcome!`,
						description: t`Thanks for signing up! You've been automatically added to ${orgNames} based on your email domain.`,
					},
					{ headers },
				)
			}
		}
	} catch (error) {
		// Don't fail the signup if domain-based organization joining fails
		console.error(
			'Error processing domain-based organization joining during signup:',
			error,
		)
	}

	// Handle referral code if present
	const referralCode = await getOnboardingReferralCode(request)
	if (referralCode) {
		try {
			const { getOrCreateWaitlistEntry, linkReferral } =
				await import('#app/utils/waitlist.server.ts')
			// Ensure waitlist entry exists before linking referral
			await getOrCreateWaitlistEntry(session.userId)
			await linkReferral(session.userId, referralCode)
		} catch (error) {
			// Don't fail the signup if referral linking fails
			console.error('Error linking referral code during signup:', error)
		}
	}

	// Check launch status and redirect accordingly
	// CLOSED_BETA: Users can sign up but are placed on waitlist
	// PUBLIC_BETA: Users can create organizations without billing (billing is hidden)
	// LAUNCHED: Full access to all features including billing
	const launchStatus = getLaunchStatus()
	if (launchStatus === 'CLOSED_BETA') {
		return redirectWithToast(
			'/waitlist',
			{
				title: t`Welcome`,
				description: t`Thanks for signing up! We'll notify you when we're ready.`,
			},
			{ headers },
		)
	}

	// PUBLIC_BETA and LAUNCHED: Allow organization creation
	// (PUBLIC_BETA users won't see billing/pricing options)
	return redirectWithToast(
		'/organizations/create',
		{ title: t`Welcome`, description: t`Thanks for signing up!` },
		{ headers },
	)
}

export const meta: Route.MetaFunction = () => {
	return [{ title: getPageTitle('Setup Account') }]
}

export default function OnboardingRoute({
	loaderData: { email, inviteToken },
	actionData,
}: Route.ComponentProps) {
	const SignupFormSchema = z
		.object({
			username: UsernameSchema,
			name: NameSchema,
			agreeToTermsOfServiceAndPrivacyPolicy: z.boolean({
				required_error: t`You must agree to the terms of service and privacy policy`,
			}),
			remember: z.boolean().optional(),
			redirectTo: z.string().optional(),
		})
		.and(PasswordAndConfirmPasswordSchema)
	const isPending = useIsPending()
	const [searchParams] = useSearchParams()
	const redirectTo = searchParams.get('redirectTo')

	const [form, fields] = useForm({
		id: 'onboarding-form',
		constraint: getZodConstraint(SignupFormSchema),
		defaultValue: { redirectTo },
		lastResult: actionData?.result,
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
		<Card>
			<CardHeader>
				<CardTitle className="text-xl">
					{inviteToken ? (
						<Trans>Complete your profile</Trans>
					) : (
						<Trans>Welcome aboard!</Trans>
					)}
				</CardTitle>
				<CardDescription>
					{inviteToken ? (
						<Trans>
							Hi {email}, please complete your profile to join the organization.
						</Trans>
					) : (
						<Trans>Hi {email}, please complete your profile.</Trans>
					)}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Form method="POST" {...getFormProps(form)}>
					<HoneypotInputs />
					<FieldGroup>
						<Field
							data-invalid={fields.username.errors?.length ? true : undefined}
						>
							<FieldLabel htmlFor={fields.username.id}>
								<Trans>Username</Trans>
							</FieldLabel>
							<Input
								{...getInputProps(fields.username, { type: 'text' })}
								autoComplete="username"
								placeholder={t`Enter your username`}
								required
								aria-invalid={fields.username.errors?.length ? true : undefined}
							/>
							<FieldError
								errors={convertErrorsToFieldFormat(fields.username.errors)}
							/>
						</Field>

						<Field data-invalid={fields.name.errors?.length ? true : undefined}>
							<FieldLabel htmlFor={fields.name.id}>
								<Trans>Full Name</Trans>
							</FieldLabel>
							<Input
								{...getInputProps(fields.name, { type: 'text' })}
								autoComplete="name"
								placeholder={t`Enter your full name`}
								required
								aria-invalid={fields.name.errors?.length ? true : undefined}
							/>
							<FieldError
								errors={convertErrorsToFieldFormat(fields.name.errors)}
							/>
						</Field>

						<Field
							data-invalid={fields.password.errors?.length ? true : undefined}
						>
							<FieldLabel htmlFor={fields.password.id}>
								<Trans>Password</Trans>
							</FieldLabel>
							<Input
								{...getInputProps(fields.password, { type: 'password' })}
								autoComplete="new-password"
								placeholder={t`Create a password`}
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
								placeholder={t`Confirm your password`}
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

						<FieldGroup>
							<Field orientation="horizontal">
								<Checkbox
									{...agreeCheckboxProps}
									id={fields.agreeToTermsOfServiceAndPrivacyPolicy.id}
								/>
								<FieldLabel
									htmlFor={fields.agreeToTermsOfServiceAndPrivacyPolicy.id}
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
								<Checkbox {...rememberCheckboxProps} id={fields.remember.id} />
								<FieldLabel
									htmlFor={fields.remember.id}
									className="font-normal"
								>
									<Trans>Remember me</Trans>
								</FieldLabel>
							</Field>
						</FieldGroup>

						<input {...getInputProps(fields.redirectTo, { type: 'hidden' })} />
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
	)
}
