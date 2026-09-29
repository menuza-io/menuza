import { invariantResponse } from '@epic-web/invariant'
import { Trans } from '@lingui/macro'
import {
	logMCPAuthorizationApproved,
	logMCPAuthorizationDenied,
} from '@repo/audit'
import { getUserId } from '@repo/auth'
import {
	and,
	db,
	eq,
	Organization,
	User,
	UserOrganization,
} from '@repo/database'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useEffect, useState } from 'react'
import {
	Form,
	redirect,
	useActionData,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import {
	createAuthorizationCode,
	validateMCPRedirectUri,
} from '#app/utils/mcp/oauth.server.ts'
import { userHasOrgAccess } from '#app/utils/organization/organizations.server.ts'
import {
	checkRateLimit,
	RATE_LIMITS,
	createRateLimitResponse,
} from '#app/utils/rate-limit.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	// Accept either client_id (standard OAuth) or client_name (MCP-specific)
	const clientId = url.searchParams.get('client_id')
	const clientName =
		url.searchParams.get('client_name') || clientId || 'MCP Client'
	const redirectUri = url.searchParams.get('redirect_uri')
	const state = url.searchParams.get('state')
	const codeChallenge = url.searchParams.get('code_challenge')
	const codeChallengeMethod = url.searchParams.get('code_challenge_method')

	// Validate required OAuth parameters
	invariantResponse(redirectUri, 'redirect_uri parameter is required', {
		status: 400,
	})

	// Validate redirect URI to prevent open redirect attacks
	// Pass clientId to validate against registered redirect URIs
	const redirectUriValidation = await validateMCPRedirectUri(
		redirectUri,
		clientId || undefined,
	)
	invariantResponse(
		redirectUriValidation.isValid,
		redirectUriValidation.error || 'Invalid redirect_uri',
		{ status: 400 },
	)

	// Note: state is optional but recommended for CSRF protection

	// Check if user has an active session
	const userId = await getUserId(request)
	if (!userId) {
		// Redirect to login with return URL
		const loginUrl = new URL('/login', request.url)
		loginUrl.searchParams.set(
			'redirectTo',
			`/mcp+/authorize?${url.searchParams.toString()}`,
		)
		throw redirect(loginUrl.toString())
	}

	// Get user and their organizations
	const [user] = await db
		.select({ id: User.id, name: User.name, username: User.username })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	const organizations = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
		})
		.from(UserOrganization)
		.innerJoin(
			Organization,
			eq(UserOrganization.organizationId, Organization.id),
		)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)

	invariantResponse(user, 'User not found', { status: 404 })
	invariantResponse(
		organizations.length > 0,
		'User has no active organizations',
		{ status: 403 },
	)

	return {
		user,
		clientId,
		clientName,
		redirectUri,
		state,
		codeChallenge,
		codeChallengeMethod,
		organizations,
	}
}

export async function action({ request }: ActionFunctionArgs) {
	invariantResponse(request.method === 'POST', 'Method not allowed', {
		status: 405,
	})

	const userId = await getUserId(request)
	invariantResponse(userId, 'User not authenticated', { status: 401 })

	// Check rate limit for authorization endpoint (10 per hour per user)
	const rateLimitCheck = await checkRateLimit(
		{ type: 'user', value: userId },
		RATE_LIMITS.authorization,
	)

	if (!rateLimitCheck.allowed) {
		await logMCPAuthorizationDenied(userId, '', 'Unknown', request)
		return createRateLimitResponse(rateLimitCheck.resetAt)
	}

	const formData = await request.formData()
	const intent = formData.get('intent')
	const organizationId = formData.get('organizationId')
	const clientId = formData.get('clientId')
	const clientName = formData.get('clientName')
	const redirectUri = formData.get('redirectUri')
	const state = formData.get('state')
	const codeChallenge = formData.get('codeChallenge')
	const codeChallengeMethod = formData.get('codeChallengeMethod')

	invariantResponse(intent, 'intent is required')
	invariantResponse(organizationId, 'organizationId is required')
	invariantResponse(clientId, 'clientId is required')
	invariantResponse(clientName, 'clientName is required')
	invariantResponse(redirectUri, 'redirectUri is required')

	// Validate redirect URI again in action (defense in depth)
	// This prevents attacks where form data could be tampered with
	// Also validates against registered redirect URIs for the client
	const actionRedirectUriValidation = await validateMCPRedirectUri(
		redirectUri as string,
		(clientId as string) || undefined,
	)
	invariantResponse(
		actionRedirectUriValidation.isValid,
		actionRedirectUriValidation.error || 'Invalid redirect_uri',
		{ status: 400 },
	)

	// Note: state is optional

	// Verify user has access to the organization
	await userHasOrgAccess(request, organizationId as string)

	if (intent === 'approve') {
		// Generate authorization code (with PKCE parameters if provided)
		const authCode = await createAuthorizationCode({
			userId,
			organizationId: organizationId as string,
			clientName: clientName as string,
			clientId: clientId as string,
			redirectUri: redirectUri as string,
			codeChallenge: codeChallenge as string | undefined,
			codeChallengeMethod: codeChallengeMethod as string | undefined,
		})

		// Log authorization approval
		await logMCPAuthorizationApproved(
			userId,
			organizationId as string,
			clientName as string,
			'', // authorizationId will be created on token exchange
			request,
		)

		// Build redirect URL with authorization code
		const redirectUrl = new URL(redirectUri as string)
		redirectUrl.searchParams.set('code', authCode)
		if (state) {
			redirectUrl.searchParams.set('state', state as string)
		}

		const redirectUrlString = redirectUrl.toString()

		// Check if redirect URI uses a custom protocol (cursor://, vscode://, etc.)
		// Custom protocols need client-side redirect, HTTP(S) can use server-side redirect
		if (
			redirectUrlString.startsWith('http://') ||
			redirectUrlString.startsWith('https://')
		) {
			// Standard HTTP redirect for regular URLs
			return redirect(redirectUrlString)
		} else {
			// Client-side redirect for custom protocols
			return { redirectUrl: redirectUrlString }
		}
	}

	if (intent === 'deny') {
		// Log authorization denial
		await logMCPAuthorizationDenied(
			userId,
			organizationId as string,
			clientName as string,
			request,
		)

		// Build redirect URL with error
		const redirectUrl = new URL(redirectUri as string)
		redirectUrl.searchParams.set('error', 'access_denied')
		redirectUrl.searchParams.set(
			'error_description',
			'User denied authorization',
		)
		if (state) {
			redirectUrl.searchParams.set('state', state as string)
		}

		const redirectUrlString = redirectUrl.toString()

		// Check if redirect URI uses a custom protocol
		if (
			redirectUrlString.startsWith('http://') ||
			redirectUrlString.startsWith('https://')
		) {
			// Standard HTTP redirect for regular URLs
			return redirect(redirectUrlString)
		} else {
			// Client-side redirect for custom protocols
			return { redirectUrl: redirectUrlString }
		}
	}

	return { error: 'Invalid intent' }
}

export default function AuthorizePage() {
	const {
		user,
		clientId,
		clientName,
		redirectUri,
		state,
		codeChallenge,
		codeChallengeMethod,
		organizations,
	} = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const [selectedOrgId, setSelectedOrgId] = useState<string>(
		organizations[0]?.id || '',
	)

	// Handle client-side redirect for custom protocols (cursor://, etc.)
	useEffect(() => {
		if (actionData && 'redirectUrl' in actionData && actionData.redirectUrl) {
			// Use window.location.href for custom protocol URLs
			window.location.href = actionData.redirectUrl
		}
	}, [actionData])

	return (
		<div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-4">
			<Dialog open={true}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<Icon name="lock" className="h-5 w-5" />
							<Trans>Authorize MCP Client</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								{clientName} is requesting access to your organization data
							</Trans>
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-6">
						{/* User Info */}
						<Card className="border-0 bg-slate-50">
							<CardHeader className="pb-3">
								<CardTitle className="text-sm">
									<Trans>Signed in as</Trans>
								</CardTitle>
							</CardHeader>
							<CardContent>
								<div className="flex items-center gap-3">
									<div className="bg-primary text-primary-foreground flex h-10 w-10 items-center justify-center rounded-full text-sm">
										{user.name?.charAt(0).toUpperCase() || 'U'}
									</div>
									<div>
										<div className="font-medium">{user.name}</div>
										<div className="text-muted-foreground text-sm">
											@{user.username}
										</div>
									</div>
								</div>
							</CardContent>
						</Card>

						{/* Organization Selection */}
						<div className="space-y-3">
							<Label htmlFor="organization-select">
								<Trans>Select Organization</Trans>
							</Label>
							<Select
								value={selectedOrgId}
								onValueChange={(value) => setSelectedOrgId(value as string)}
								items={organizations.map((org) => ({
									value: org.id,
									label: org.name,
								}))}
							>
								<SelectTrigger id="organization-select">
									<SelectValue placeholder="Select an organization" />
								</SelectTrigger>
								<SelectContent>
									{organizations.map((org) => (
										<SelectItem key={org.id} value={org.id}>
											{org.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								<Trans>
									The MCP client will only have access to data from the selected
									organization
								</Trans>
							</p>
						</div>

						{/* Permissions Info */}
						<Card className="border-0 bg-blue-50">
							<CardHeader className="pb-3">
								<CardTitle className="text-sm">
									<Trans>This client will have access to:</Trans>
								</CardTitle>
							</CardHeader>
							<CardContent>
								<ul className="space-y-2 text-sm">
									<li className="flex items-start gap-2">
										<Icon
											name="check"
											className="text-primary mt-0.5 h-4 w-4 shrink-0"
										/>
										<span>
											<Trans>Search for users in your organization</Trans>
										</span>
									</li>
									<li className="flex items-start gap-2">
										<Icon
											name="check"
											className="text-primary mt-0.5 h-4 w-4 shrink-0"
										/>
										<span>
											<Trans>View notes from users you have access to</Trans>
										</span>
									</li>
								</ul>
							</CardContent>
						</Card>

						{/* Security Info */}
						<Card className="border-0 bg-amber-50">
							<CardHeader className="pb-3">
								<CardTitle className="text-sm">
									<Trans>Security</Trans>
								</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="text-muted-foreground text-xs">
									<Trans>
										You can revoke this access at any time from your MCP
										settings page. The access token will expire in 1 hour.
									</Trans>
								</p>
							</CardContent>
						</Card>
					</div>

					<DialogFooter className="gap-2">
						<Form method="post" className="flex w-full gap-2">
							<input type="hidden" name="intent" value="deny" />
							<input
								type="hidden"
								name="organizationId"
								value={selectedOrgId}
							/>
							<input
								type="hidden"
								name="clientId"
								value={clientId || 'missing_client_id'}
							/>
							<input type="hidden" name="clientName" value={clientName} />
							<input type="hidden" name="redirectUri" value={redirectUri} />
							{state && <input type="hidden" name="state" value={state} />}
							{codeChallenge && (
								<input
									type="hidden"
									name="codeChallenge"
									value={codeChallenge}
								/>
							)}
							{codeChallengeMethod && (
								<input
									type="hidden"
									name="codeChallengeMethod"
									value={codeChallengeMethod}
								/>
							)}
							<Button
								type="submit"
								variant="outline"
								className="flex-1"
								disabled={!selectedOrgId}
							>
								<Trans>Deny</Trans>
							</Button>
						</Form>

						<Form method="post" className="flex flex-1">
							<input type="hidden" name="intent" value="approve" />
							<input
								type="hidden"
								name="organizationId"
								value={selectedOrgId}
							/>
							<input
								type="hidden"
								name="clientId"
								value={clientId || 'missing_client_id'}
							/>
							<input type="hidden" name="clientName" value={clientName} />
							<input type="hidden" name="redirectUri" value={redirectUri} />
							{state && <input type="hidden" name="state" value={state} />}
							{codeChallenge && (
								<input
									type="hidden"
									name="codeChallenge"
									value={codeChallenge}
								/>
							)}
							{codeChallengeMethod && (
								<input
									type="hidden"
									name="codeChallengeMethod"
									value={codeChallengeMethod}
								/>
							)}
							<Button
								type="submit"
								className="w-full gap-2"
								disabled={!selectedOrgId}
							>
								<Icon name="check" className="h-4 w-4" />
								<Trans>Authorize</Trans>
							</Button>
						</Form>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}
