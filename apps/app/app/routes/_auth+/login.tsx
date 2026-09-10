import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { Trans, t } from '@lingui/macro'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { auditService, AuditAction } from '@repo/audit'
import { requireAnonymous } from '@repo/auth'
import { providerNames } from '@repo/auth/constants'
import { getErrorMessage, useIsPending } from '@repo/common'
import { sharedCookieDomain } from '@repo/common/cookie-domain'
import { getPageTitle } from '@repo/config/brand'
import { checkHoneypot } from '@repo/security'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Field, FieldLabel, FieldError, FieldGroup } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { StatusButton } from '@repo/ui/status-button'
import { LoginPasswordSchema } from '@repo/validation'
import { startAuthentication } from '@simplewebauthn/browser'
import { type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server'
import { useOptimistic, useState, useTransition } from 'react'
import {
	data,
	Form,
	Link,
	useNavigate,
	useNavigation,
	useSearchParams,
} from 'react-router'
import { HoneypotInputs } from 'remix-utils/honeypot/react'
import { z } from 'zod'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	ErrorList,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'
import { ensureLinguiRequestLocale } from '#app/modules/lingui/lingui.server.ts'
import { login } from '#app/utils/auth.server.ts'
import { ProviderConnectionForm } from '#app/utils/connections.tsx'
import { ENV } from '#app/utils/env.server.ts'
import {
	saveLastLoginMethod,
	useLastLoginMethod,
} from '#app/utils/last-login-method.ts'
import {
	getOrganizationBySlug,
	discoverOrganizationFromEmail,
} from '#app/utils/organization/organizations.server.ts'
import { ssoConfigurationService } from '#app/utils/sso/configuration.server.ts'
import { checkSSOEnforcementByEmail } from '#app/utils/sso/enforcement.server.ts'
import { type Route } from './+types/login.ts'
import { handleNewSession } from './login.server.ts'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

const AuthenticationOptionsSchema = z.object({
	options: z.object({ challenge: z.string() }),
}) satisfies z.ZodType<{ options: PublicKeyCredentialRequestOptionsJSON }>

export async function loader({ request }: Route.LoaderArgs) {
	await requireAnonymous(request)

	const url = new URL(request.url)
	const orgSlug = url.searchParams.get('org')

	let ssoConfig = null
	let organization = null

	if (orgSlug) {
		organization = await getOrganizationBySlug(orgSlug)
		if (organization) {
			ssoConfig = await ssoConfigurationService.getConfiguration(
				organization.id,
			)
		}
	}

	// DEBUG: expose cookie domain info so we can verify the fix in production
	// (hidden in the DOM via data attributes — remove after confirming fix)
	const debugBaseUrl = process.env.BASE_URL || ENV.BASE_URL || '(unset)'
	const debugCookieDomain = sharedCookieDomain(debugBaseUrl) ?? '(host-only)'

	return {
		organization,
		ssoConfig: ssoConfig && ssoConfig.isEnabled ? ssoConfig : null,
		debugBaseUrl,
		debugCookieDomain,
	}
}

export async function action({ request }: Route.ActionArgs) {
	await ensureLinguiRequestLocale(request)
	await requireAnonymous(request)
	const formData = await request.formData()
	await checkHoneypot(formData)

	const intent = formData.get('intent')

	const LoginFormSchema = z.object({
		username: z.string().min(1, t`Username or email is required`),
		password: LoginPasswordSchema,
		redirectTo: z.string().optional(),
		remember: z.boolean().optional(),
	})

	const EmailCheckSchema = z.object({
		username: z.string().min(1, t`Please enter your email or username`),
		redirectTo: z.string().optional(),
	})

	// Login is protected by the server-level rate limiter (10 requests/min for
	// paths including /login - see apps/app/server/index.ts).

	// Handle email check to discover SSO
	if (intent === 'check-email') {
		const submission = parseWithZod(formData, { schema: EmailCheckSchema })

		if (submission.status !== 'success') {
			return data({ result: submission.reply() })
		}

		const { username } = submission.value

		// Only try SSO discovery if input looks like an email
		if (username.includes('@')) {
			// Try to discover organization from email
			const organization = await discoverOrganizationFromEmail(username)

			if (organization) {
				// Check if organization has SSO enabled
				const ssoConfig = await ssoConfigurationService.getConfiguration(
					organization.id,
				)

				if (ssoConfig && ssoConfig.isEnabled) {
					const safeSSOConfig = {
						id: ssoConfig.id,
						providerName: ssoConfig.providerName,
						issuerUrl: ssoConfig.issuerUrl,
						clientId: ssoConfig.clientId,
						scopes: ssoConfig.scopes,
						autoDiscovery: ssoConfig.autoDiscovery,
						pkceEnabled: ssoConfig.pkceEnabled,
						isEnabled: ssoConfig.isEnabled,
					}

					return data({
						result: submission.reply(),
						ssoAvailable: true,
						organization,
						ssoConfig: safeSSOConfig,
						username,
					})
				}
			}
		}

		// No SSO available (either not an email or no SSO configured), continue with password flow
		return data({
			result: submission.reply(),
			ssoAvailable: false,
			username,
		})
	}

	// Handle regular login
	const submission = await parseWithZod(formData, {
		schema: (intent) =>
			LoginFormSchema.transform(async (data, ctx) => {
				if (intent !== null) return { ...data, session: null }

				// Check SSO enforcement before allowing password login
				const ssoEnforcement = await checkSSOEnforcementByEmail(data.username)
				if (ssoEnforcement.enforced) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Your organization requires SSO login. Please use the SSO login option for ${ssoEnforcement.organizationName || 'your organization'}.`,
					})
					return z.NEVER
				}

				const session = await login({
					username: data.username,
					password: data.password,
					request,
					remember: data.remember ?? false,
				})
				if (!session) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: t`Invalid username or password`,
					})
					return z.NEVER
				}

				return { ...data, session }
			}),
		async: true,
	})

	if (submission.status !== 'success' || !submission.value.session) {
		// Log failed login attempt (SOC 2 CC7.2)
		const username = formData.get('username')?.toString()
		void auditService.logAuth(
			AuditAction.USER_LOGIN_FAILED,
			undefined,
			`Failed login attempt for: ${username}`,
			{ username, source: 'web' },
			request,
			false,
		)

		return data(
			{
				result: submission.reply({ hideFields: ['password'] }),
				username,
				ssoAvailable: false,
			},
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { session, remember, redirectTo } = submission.value

	console.log('LOGIN SUCCESS! REDIRECT TO:', redirectTo)
	return handleNewSession({
		request,
		session,
		remember: remember ?? false,
		redirectTo,
	})
}

export default function LoginPage({
	actionData,
	loaderData,
}: Route.ComponentProps) {
	const [searchParams] = useSearchParams()
	const redirectTo = searchParams.get('redirectTo')
	const isBanned = searchParams.get('banned') === 'true'
	const error = searchParams.get('error')
	const { organization, ssoConfig, debugBaseUrl, debugCookieDomain } =
		loaderData

	// Determine the current step based on action data
	const ssoAvailable = (actionData as any)?.ssoAvailable
	const discoveredUsername = (actionData as any)?.username
	const discoveredOrganization = (actionData as any)?.organization
	const discoveredSSOConfig = (actionData as any)?.ssoConfig

	// Check if user wants to use password instead of SSO
	const usePassword = searchParams.get('usePassword') === 'true'
	const usernameFromParams = searchParams.get('username')

	return (
		<>
			{/* DEBUG: hidden element to verify cookie domain in production — remove after confirming fix */}
			<span
				aria-hidden="true"
				style={{ display: 'none' }}
				data-debug-base-url={debugBaseUrl}
				data-debug-cookie-domain={debugCookieDomain}
				id="__debug_cookie_domain"
			/>
			<Card>
				<CardHeader>
					<CardTitle className="text-xl">
						<Trans>Welcome back</Trans>
					</CardTitle>
					<CardDescription>
						{ssoAvailable && discoveredOrganization && !usePassword ? (
							`Sign in to ${discoveredOrganization.name}`
						) : (discoveredUsername && ssoAvailable === false) ||
						  usePassword ||
						  organization ? (
							<Trans>Continue with your password</Trans>
						) : (
							<Trans>Sign in to your account</Trans>
						)}
					</CardDescription>
				</CardHeader>
				<CardContent>
					{isBanned && (
						<div className="border-destructive bg-destructive/10 mb-4 rounded-lg border p-4">
							<div className="text-destructive flex items-center gap-2">
								<Icon name="lock" className="h-5 w-5" />
								<h3 className="font-semibold">
									<Trans>Account Suspended</Trans>
								</h3>
							</div>
							<p className="text-destructive/80 mt-2 text-sm">
								<Trans>
									Your account has been suspended. Please contact support if you
									believe this is an error.
								</Trans>
							</p>
						</div>
					)}

					{error && (
						<div className="mb-4 rounded-lg border border-orange-500 bg-orange-50 p-4">
							<div className="flex items-center gap-2 text-orange-700">
								<Icon name="alert-triangle" className="h-5 w-5" />
								<h3 className="font-semibold">
									<Trans>Login Error</Trans>
								</h3>
							</div>
							<p className="mt-2 text-sm text-orange-600">
								<Trans>
									There was an issue with your login attempt. Please try again.
								</Trans>
							</p>
						</div>
					)}

					<div className="space-y-6">
						{/* Social Login Buttons - Always show first */}
						<SocialLoginButtons redirectTo={redirectTo} />

						{/* Divider */}
						<div className="after:border-border relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t">
							<span className="bg-card text-muted-foreground relative z-10 px-2">
								<Trans>Or continue with email or username</Trans>
							</span>
						</div>

						{/* Step 1: Username/Email Input (initial state) */}
						{!discoveredUsername && !organization && !usernameFromParams && (
							<UsernameInputStep
								redirectTo={redirectTo}
								actionData={actionData}
							/>
						)}

						{/* Step 2: SSO Available - Show SSO option */}
						{ssoAvailable &&
							discoveredOrganization &&
							discoveredSSOConfig &&
							!usePassword && (
								<SSOLoginStep
									organization={discoveredOrganization}
									ssoConfig={discoveredSSOConfig}
									username={discoveredUsername}
									redirectTo={redirectTo}
								/>
							)}

						{/* Step 3: Password Login - Show when no SSO or user chose password */}
						{((discoveredUsername && ssoAvailable === false) ||
							usePassword ||
							organization ||
							usernameFromParams) && (
							<PasswordLoginStep
								username={discoveredUsername || usernameFromParams}
								organization={organization || discoveredOrganization}
								ssoConfig={ssoConfig || discoveredSSOConfig}
								redirectTo={redirectTo}
								actionData={actionData}
								showBackToSSO={
									usePassword && ssoAvailable && discoveredSSOConfig
								}
							/>
						)}
					</div>
				</CardContent>
				<CardFooter className="block rounded-lg p-4 text-center text-sm">
					<Trans>Don't have an account?</Trans>{' '}
					<Link
						to={
							redirectTo
								? `/signup?redirectTo=${encodeURIComponent(redirectTo)}`
								: '/signup'
						}
						className="font-medium underline underline-offset-4"
					>
						<Trans>Create account</Trans>
					</Link>
				</CardFooter>
			</Card>
		</>
	)
}

const VerificationResponseSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('success'),
		location: z.string(),
	}),
	z.object({
		status: z.literal('error'),
		error: z.string(),
	}),
])

function PasskeyLogin({
	redirectTo,
	remember,
}: {
	redirectTo: string | null
	remember: boolean
}) {
	const [isPending] = useTransition()
	const [error, setError] = useState<string | null>(null)
	const [passkeyMessage, setPasskeyMessage] = useOptimistic<string | null>(
		t`Login with a passkey`,
	)
	const navigate = useNavigate()

	async function handlePasskeyLogin() {
		try {
			setPasskeyMessage(t`Generating Authentication Options`)
			// Get authentication options from the server
			const optionsResponse = await fetch('/webauthn/authentication')
			const json = await optionsResponse.json()
			const { options } = AuthenticationOptionsSchema.parse(json)

			setPasskeyMessage(t`Requesting your authorization`)
			const authResponse = await startAuthentication({ optionsJSON: options })
			setPasskeyMessage(t`Verifying your passkey`)

			// Verify the authentication with the server
			const verificationResponse = await fetch('/webauthn/authentication', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ authResponse, remember, redirectTo }),
			})

			const verificationJson = await verificationResponse.json().catch(() => ({
				status: 'error',
				error: 'Unknown error',
			}))

			const parsedResult =
				VerificationResponseSchema.safeParse(verificationJson)
			if (!parsedResult.success) {
				throw new Error(parsedResult.error.message)
			} else if (parsedResult.data.status === 'error') {
				throw new Error(parsedResult.data.error)
			}
			const { location } = parsedResult.data

			// Save the successful login method
			saveLastLoginMethod('passkey')

			setPasskeyMessage(t`You're logged in! Navigating...`)
			await navigate(location ?? '/')
		} catch (e) {
			const errorMessage = getErrorMessage(e)
			setError(t`Failed to authenticate with passkey: ${errorMessage}`)
		}
	}

	return (
		<form action={handlePasskeyLogin}>
			<StatusButton
				id="passkey-login-button"
				aria-describedby="passkey-login-button-error"
				className="w-full"
				status={isPending ? 'pending' : error ? 'error' : 'idle'}
				type="submit"
				disabled={isPending}
			>
				<span className="inline-flex items-center gap-1.5">
					<Icon name="passkey" />
					<span>{passkeyMessage}</span>
				</span>
			</StatusButton>
			<div className="mt-2">
				<ErrorList errors={[error]} id="passkey-login-button-error" />
			</div>
		</form>
	)
}

function SocialLoginButtons({ redirectTo }: { redirectTo: string | null }) {
	const lastLoginMethod = useLastLoginMethod()

	return (
		<div className="flex flex-col gap-3">
			{/* Social Login Buttons */}
			{providerNames.map((providerName) => (
				<div key={providerName} className="relative">
					<ProviderConnectionForm
						type="Login"
						providerName={providerName}
						redirectTo={redirectTo}
					/>
					{lastLoginMethod === providerName && (
						<div className="bg-foreground text-primary-foreground absolute -top-2 -right-2 rounded-full px-2 py-0.5 text-xs font-medium">
							<Trans>Last used</Trans>
						</div>
					)}
				</div>
			))}

			{/* Passkey Login */}
			<div className="relative">
				<PasskeyLogin redirectTo={redirectTo} remember={false} />
				{lastLoginMethod === 'passkey' && (
					<div className="bg-primary text-primary-foreground absolute -top-2 -right-2 rounded-full px-2 py-1 text-xs font-medium">
						<Trans>Last used</Trans>
					</div>
				)}
			</div>
		</div>
	)
}

function SSOLoginStep({
	organization,
	ssoConfig,
	username,
	redirectTo,
}: {
	organization: any
	ssoConfig: any
	username: string
	redirectTo: string | null
}) {
	const navigate = useNavigate()
	const navigation = useNavigation()
	const isPending =
		navigation.state === 'submitting' &&
		navigation.formAction === `/auth/sso/${organization.slug}`

	const handleSSOLogin = () => {
		saveLastLoginMethod('sso')
	}

	const handleUsePassword = async () => {
		// This will trigger a re-render showing the password step
		// We can do this by setting a flag or navigating with a parameter
		const url = new URL(window.location.href)
		url.searchParams.set('usePassword', 'true')
		url.searchParams.set('username', username)
		await navigate(url.pathname + url.search, { replace: true })
	}

	const getProviderDisplayName = (provider: string) => {
		switch (provider.toLowerCase()) {
			case 'okta':
				return 'Okta'
			case 'azure-ad':
				return 'Microsoft Azure AD'
			case 'auth0':
				return 'Auth0'
			case 'google':
				return 'Google Workspace'
			default:
				return provider.charAt(0).toUpperCase() + provider.slice(1)
		}
	}

	const getProviderIcon = (provider: string) => {
		switch (provider.toLowerCase()) {
			case 'okta':
				return 'lock'
			case 'azure-ad':
				return 'shield'
			case 'auth0':
				return 'shield-check'
			case 'google':
				return 'google'
			default:
				return 'building'
		}
	}

	return (
		<div className="space-y-4">
			<div className="space-y-2 text-center">
				<div className="text-muted-foreground text-sm">
					<Trans>Signing in as</Trans>{' '}
					<span className="font-medium">{username}</span>
				</div>
				<div className="text-muted-foreground text-xs">
					<Trans>We found your organization:</Trans> {organization.name}
				</div>
			</div>

			<Form method="POST" action={`/auth/sso/${organization.slug}`}>
				{redirectTo && (
					<input type="hidden" name="redirectTo" value={redirectTo} />
				)}
				<StatusButton
					className="w-full justify-start"
					status={isPending ? 'pending' : 'idle'}
					type="submit"
					disabled={isPending}
					onClick={handleSSOLogin}
				>
					<span className="inline-flex items-center gap-3">
						<Icon
							name={getProviderIcon(ssoConfig.providerName)}
							className="h-5 w-5"
						/>
						<div className="flex flex-col items-start">
							<span className="font-medium">
								<Trans>Continue with</Trans>{' '}
								{getProviderDisplayName(ssoConfig.providerName)}
							</span>
							<span className="text-xs opacity-90">
								<Trans>Recommended for</Trans> {organization.name}
							</span>
						</div>
					</span>
				</StatusButton>
			</Form>

			<div className="text-center">
				<button
					type="button"
					onClick={handleUsePassword}
					className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
				>
					<Trans>Use password instead</Trans>
				</button>
			</div>
		</div>
	)
}

function UsernameInputStep({
	redirectTo,
	actionData,
}: {
	redirectTo: string | null
	actionData: any
}) {
	const isPending = useIsPending()

	const EmailCheckSchema = z.object({
		username: z.string().min(1, t`Please enter your email or username`),
		redirectTo: z.string().optional(),
	})

	const [usernameForm, usernameFields] = useForm({
		id: 'username-check-form',
		constraint: getZodConstraint(EmailCheckSchema),
		defaultValue: { redirectTo },
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: EmailCheckSchema })
		},
		shouldRevalidate: 'onBlur',
	})

	return (
		<Form method="POST" {...getFormProps(usernameForm)}>
			<HoneypotInputs />
			<input type="hidden" name="intent" value="check-email" />

			<FieldGroup>
				<Field
					data-invalid={
						usernameFields.username.errors?.length ? true : undefined
					}
				>
					<FieldLabel htmlFor={usernameFields.username.id}>
						<Trans>Email or Username</Trans>
					</FieldLabel>
					<Input
						{...getInputProps(usernameFields.username, { type: 'text' })}
						autoFocus
						autoComplete="username"
						placeholder={t`Enter your email or username`}
						aria-invalid={
							usernameFields.username.errors?.length ? true : undefined
						}
					/>
					<FieldError
						errors={convertErrorsToFieldFormat(usernameFields.username.errors)}
					/>
				</Field>

				<input
					{...getInputProps(usernameFields.redirectTo, { type: 'hidden' })}
				/>
				<ErrorList errors={usernameForm.errors} id={usernameForm.errorId} />

				<StatusButton
					className="w-full"
					status={isPending ? 'pending' : (usernameForm.status ?? 'idle')}
					type="submit"
					disabled={isPending}
				>
					<Trans>Continue</Trans>
				</StatusButton>
			</FieldGroup>
		</Form>
	)
}

function PasswordLoginStep({
	username,
	organization,
	redirectTo,
	actionData,
	showBackToSSO = false,
}: {
	username?: string
	organization?: any
	ssoConfig?: any
	redirectTo: string | null
	actionData: any
	showBackToSSO?: boolean
}) {
	const LoginFormSchema = z.object({
		username: z.string().min(1, t`Username or email is required`),
		password: LoginPasswordSchema,
		redirectTo: z.string().optional(),
		remember: z.boolean().optional(),
	})

	const isPending = useIsPending()
	const navigate = useNavigate()

	const [form, fields] = useForm({
		id: 'login-form',
		constraint: getZodConstraint(LoginFormSchema),
		defaultValue: {
			redirectTo,
			username: username || '',
		},
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: LoginFormSchema })
		},
		shouldRevalidate: 'onBlur',
		onSubmit: () => {
			saveLastLoginMethod('password')
		},
	})

	const handleBackToSSO = async () => {
		const url = new URL(window.location.href)
		url.searchParams.delete('usePassword')
		url.searchParams.delete('username')
		await navigate(url.pathname + url.search, { replace: true })
	}

	return (
		<div className="space-y-4">
			{username && (
				<div className="space-y-2 text-center">
					<div className="text-muted-foreground text-sm">
						<Trans>Signing in as</Trans>{' '}
						<span className="font-medium">{username}</span>
					</div>
					{organization && (
						<div className="text-muted-foreground text-xs">
							{organization.name}
						</div>
					)}
				</div>
			)}

			{showBackToSSO && (
				<div className="text-center">
					<button
						type="button"
						onClick={handleBackToSSO}
						className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
					>
						<Trans>← Back to SSO login</Trans>
					</button>
				</div>
			)}

			<Form method="POST" {...getFormProps(form)}>
				<HoneypotInputs />

				<FieldGroup>
					<Field
						data-invalid={fields.username.errors?.length ? true : undefined}
					>
						<FieldLabel htmlFor={fields.username.id}>
							{username ? (
								username.includes('@') ? (
									<Trans>Email</Trans>
								) : (
									<Trans>Username</Trans>
								)
							) : (
								<Trans>Email or Username</Trans>
							)}
						</FieldLabel>
						<Input
							{...getInputProps(fields.username, { type: 'text' })}
							autoComplete="username"
							placeholder={
								username ? username : t`Enter your email or username`
							}
							readOnly={!!username}
							className={username ? 'bg-muted' : ''}
							aria-invalid={fields.username.errors?.length ? true : undefined}
						/>
						<FieldError
							errors={convertErrorsToFieldFormat(fields.username.errors)}
						/>
					</Field>

					<Field
						data-invalid={fields.password.errors?.length ? true : undefined}
					>
						<div className="flex items-center">
							<FieldLabel htmlFor={fields.password.id}>
								<Trans>Password</Trans>
							</FieldLabel>
							<Link
								to="/forgot-password"
								className="ml-auto text-sm underline-offset-4 hover:underline"
							>
								<Trans>Forgot your password?</Trans>
							</Link>
						</div>
						<Input
							{...getInputProps(fields.password, { type: 'password' })}
							autoFocus={!!username}
							autoComplete="current-password"
							placeholder={t`Enter your password`}
							aria-invalid={fields.password.errors?.length ? true : undefined}
						/>
						<FieldError
							errors={convertErrorsToFieldFormat(fields.password.errors)}
						/>
					</Field>

					<Field orientation="horizontal">
						<Checkbox
							{...(() => {
								const { type: _type, ...props } = getInputProps(
									fields.remember,
									{
										type: 'checkbox',
									},
								)
								return props
							})()}
							id={fields.remember.id}
						/>
						<FieldLabel htmlFor={fields.remember.id} className="font-normal">
							<Trans>Remember me</Trans>
						</FieldLabel>
					</Field>

					<input {...getInputProps(fields.redirectTo, { type: 'hidden' })} />
					<ErrorList errors={form.errors} id={form.errorId} />

					<StatusButton
						className="w-full"
						status={isPending ? 'pending' : (form.status ?? 'idle')}
						type="submit"
						disabled={isPending}
					>
						<Trans>Sign In</Trans>
					</StatusButton>
				</FieldGroup>
			</Form>
		</div>
	)
}

export const meta: Route.MetaFunction = () => {
	return [{ title: getPageTitle('Login') }]
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
