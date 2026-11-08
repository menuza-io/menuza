import { Trans, msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { Form } from 'react-router'
import { z } from 'zod'

const ignoredSSOConfigurationSchema = z.object({
	providerName: z.string().min(1, 'Provider name is required'),
	issuerUrl: z.string().url('Must be a valid URL'),
	clientId: z.string().min(1, 'Client ID is required'),
	clientSecret: z.string().min(1, 'Client secret is required'),
	scopes: z.string().default('openid email profile'),
	// Transform checkbox values to booleans
	autoDiscovery: z
		.union([z.literal('on'), z.literal('off'), z.boolean()])
		.transform((val) => val === 'on' || val === true)
		.default(true),
	pkceEnabled: z
		.union([z.literal('on'), z.literal('off'), z.boolean()])
		.transform((val) => val === 'on' || val === true)
		.default(true),
	autoProvision: z
		.union([z.literal('on'), z.literal('off'), z.boolean()])
		.transform((val) => val === 'on' || val === true)
		.default(true),
	defaultRole: z.string().default('member'),
	attributeMapping: z.string().optional(),
	allowedEmailDomains: z.string().min(1, 'Enter at least one email domain'),
	requireVerifiedEmail: z
		.union([z.literal('on'), z.literal('off'), z.boolean()])
		.transform((val) => val === 'on' || val === true)
		.default(false),
	// Manual endpoint configuration (when autoDiscovery is false)
	authorizationUrl: z.string().url().optional(),
	tokenUrl: z.string().url().optional(),
	userinfoUrl: z.string().url().optional(),
	revocationUrl: z.string().url().optional(),
})

export type SSOConfigurationFormData = z.infer<
	typeof ignoredSSOConfigurationSchema
>

interface SSOConfigurationFormProps {
	organizationId: string
	existingConfig?: {
		id: string
		providerName: string
		issuerUrl: string
		clientId: string
		clientSecret: string
		scopes: string
		autoDiscovery: boolean
		pkceEnabled: boolean
		autoProvision: boolean
		allowedEmailDomains?: string | null
		requireVerifiedEmail?: boolean
		defaultRole: string
		attributeMapping: string | null
		authorizationUrl: string | null
		tokenUrl: string | null
		userinfoUrl: string | null
		revocationUrl: string | null
		isEnabled: boolean
		lastTested: Date | null
	} | null
	isSubmitting?: boolean
	testConnectionResult?: {
		success: boolean
		message: string
		discoveredEndpoints?: {
			authorization_endpoint: string
			token_endpoint: string
			userinfo_endpoint?: string
			revocation_endpoint?: string
		}
	} | null
}

export function SSOConfigurationForm({
	organizationId,
	existingConfig,
	isSubmitting = false,
	testConnectionResult,
}: SSOConfigurationFormProps) {
	const { _ } = useLingui()
	// State for reactive form controls
	const [autoDiscoveryEnabled, setAutoDiscoveryEnabled] = useState(
		existingConfig?.autoDiscovery ?? true,
	)

	return (
		<div className="space-y-6">
			{/* Connection Test Result */}
			{testConnectionResult && (
				<div
					className={`flex items-center gap-2 rounded-lg border p-4 ${
						testConnectionResult.success
							? 'border-green-200 bg-green-50 text-green-800'
							: 'border-red-200 bg-red-50 text-red-800'
					}`}
				>
					<Icon
						name={
							testConnectionResult.success ? 'check-circle' : 'alert-triangle'
						}
						className="h-4 w-4"
					/>
					<span>{testConnectionResult.message}</span>
				</div>
			)}

			<Form method="post" className="space-y-6">
				<input type="hidden" name="organizationId" value={organizationId} />
				{existingConfig && (
					<input type="hidden" name="configId" value={existingConfig.id} />
				)}

				{/* Basic Configuration */}
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Icon name="settings" className="h-5 w-5" />
							<Trans>Identity Provider Configuration</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								Configure your organization's identity provider settings
							</Trans>
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="providerName">
								<Trans>Provider Name</Trans>
							</Label>
							<Input
								id="providerName"
								name="providerName"
								type="text"
								placeholder={_(msg`e.g., Okta, Azure AD, Auth0`)}
								defaultValue={existingConfig?.providerName || ''}
								required
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="issuerUrl">
								<Trans>Issuer URL</Trans>
							</Label>
							<Input
								id="issuerUrl"
								name="issuerUrl"
								type="url"
								placeholder={_(t`https://your-domain.okta.com`)}
								defaultValue={existingConfig?.issuerUrl || ''}
								required
							/>
						</div>

						<div className="grid gap-4 md:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="clientId">
									<Trans>Client ID</Trans>
								</Label>
								<Input
									id="clientId"
									name="clientId"
									type="text"
									placeholder={_(msg`OAuth2 Client ID`)}
									defaultValue={existingConfig?.clientId || ''}
									required
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="clientSecret">
									<Trans>Client Secret</Trans>
								</Label>
								<Input
									id="clientSecret"
									name="clientSecret"
									type="password"
									placeholder={_(msg`OAuth2 Client Secret`)}
									defaultValue={existingConfig?.clientSecret || ''}
									required
								/>
							</div>
						</div>

						<div className="space-y-2">
							<Label htmlFor="scopes">
								<Trans>Scopes</Trans>
							</Label>
							<Input
								id="scopes"
								name="scopes"
								type="text"
								placeholder={_(t`openid email profile`)}
								defaultValue={existingConfig?.scopes || 'openid email profile'}
							/>
						</div>
					</CardContent>
				</Card>

				{/* OAuth2 Configuration */}
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Icon name="link-2" className="h-5 w-5" />
							<Trans>OAuth2 Configuration</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>Configure OAuth2 endpoints and security settings</Trans>
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<Label className="hover:bg-accent/50 has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-accent/50 flex items-start gap-2 rounded-lg border p-3">
							<Checkbox
								id="autoDiscovery"
								name="autoDiscovery"
								defaultChecked={existingConfig?.autoDiscovery ?? true}
								onCheckedChange={(checked) =>
									setAutoDiscoveryEnabled(!!checked)
								}
							/>
							<div className="flex flex-col gap-1">
								<p>
									<Trans>Auto-Discovery</Trans>
								</p>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Automatically discover OAuth2 endpoints from the issuer URL
									</Trans>
								</p>
							</div>
						</Label>

						{!autoDiscoveryEnabled && (
							<div className="space-y-4 rounded-lg border p-4">
								<h4 className="font-medium">
									<Trans>Manual Endpoint Configuration</Trans>
								</h4>
								<div className="grid gap-4 md:grid-cols-2">
									<div className="space-y-2">
										<Label htmlFor="authorizationUrl">
											<Trans>Authorization URL</Trans>
										</Label>
										<Input
											id="authorizationUrl"
											name="authorizationUrl"
											type="url"
											placeholder={_(
												t`https://your-domain.okta.com/oauth2/v1/authorize`,
											)}
											defaultValue={existingConfig?.authorizationUrl || ''}
										/>
									</div>

									<div className="space-y-2">
										<Label htmlFor="tokenUrl">
											<Trans>Token URL</Trans>
										</Label>
										<Input
											id="tokenUrl"
											name="tokenUrl"
											type="url"
											placeholder={_(
												t`https://your-domain.okta.com/oauth2/v1/token`,
											)}
											defaultValue={existingConfig?.tokenUrl || ''}
										/>
									</div>

									<div className="space-y-2">
										<Label htmlFor="userinfoUrl">
											<Trans>UserInfo URL</Trans>
										</Label>
										<Input
											id="userinfoUrl"
											name="userinfoUrl"
											type="url"
											placeholder={_(
												t`https://your-domain.okta.com/oauth2/v1/userinfo`,
											)}
											defaultValue={existingConfig?.userinfoUrl || ''}
										/>
									</div>

									<div className="space-y-2">
										<Label htmlFor="revocationUrl">
											<Trans>Revocation URL (Optional)</Trans>
										</Label>
										<Input
											id="revocationUrl"
											name="revocationUrl"
											type="url"
											placeholder={_(
												t`https://your-domain.okta.com/oauth2/v1/revoke`,
											)}
											defaultValue={existingConfig?.revocationUrl || ''}
										/>
									</div>
								</div>
							</div>
						)}

						<Label className="hover:bg-accent/50 has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-accent/50 flex items-start gap-2 rounded-lg border p-3">
							<Checkbox
								id="pkceEnabled"
								name="pkceEnabled"
								defaultChecked={existingConfig?.pkceEnabled ?? true}
							/>
							<div className="flex flex-col gap-1">
								<p>
									<Trans>PKCE Enabled</Trans>
								</p>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Use Proof Key for Code Exchange for enhanced security
									</Trans>
								</p>
							</div>
						</Label>
					</CardContent>
				</Card>

				{/* User Provisioning */}
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Icon name="user-plus" className="h-5 w-5" />
							<Trans>User Provisioning</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								Configure how users are created and managed through SSO
							</Trans>
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="allowedEmailDomains">
								<Trans>Allowed email domains</Trans>
							</Label>
							<Input
								id="allowedEmailDomains"
								name="allowedEmailDomains"
								required
								placeholder="acme.com, acme.co.uk"
								defaultValue={existingConfig?.allowedEmailDomains ?? ''}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Required. The identity provider can only create accounts and
									sign people in for email addresses on these domains.
								</Trans>
							</p>
						</div>

						<Label className="hover:bg-accent/50 has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-accent/50 flex items-start gap-2 rounded-lg border p-3">
							<Checkbox
								id="requireVerifiedEmail"
								name="requireVerifiedEmail"
								defaultChecked={existingConfig?.requireVerifiedEmail ?? false}
							/>
							<div className="flex flex-col gap-1">
								<p>
									<Trans>Require a verified email</Trans>
								</p>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Refuse sign-in unless the identity provider marks the email
										as verified (email_verified). Some providers, such as
										Microsoft Entra ID, do not send it.
									</Trans>
								</p>
							</div>
						</Label>

						<Label className="hover:bg-accent/50 has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-accent/50 flex items-start gap-2 rounded-lg border p-3">
							<Checkbox
								id="autoProvision"
								name="autoProvision"
								defaultChecked={existingConfig?.autoProvision ?? true}
							/>
							<div className="flex flex-col gap-1">
								<p>
									<Trans>Auto-Provision Users</Trans>
								</p>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Automatically create user accounts for new SSO users
									</Trans>
								</p>
							</div>
						</Label>

						<div className="space-y-2">
							<Label htmlFor="defaultRole">
								<Trans>Default Role</Trans>
							</Label>
							<Select
								name="defaultRole"
								defaultValue={existingConfig?.defaultRole || 'member'}
								items={[
									{ value: 'admin', label: 'Admin' },
									{ value: 'member', label: 'Member' },
									{ value: 'viewer', label: 'Viewer' },
									{ value: 'guest', label: 'Guest' },
								]}
							>
								<SelectTrigger id="defaultRole">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="admin">
										<Trans>Admin</Trans>
									</SelectItem>
									<SelectItem value="member">
										<Trans>Member</Trans>
									</SelectItem>
									<SelectItem value="viewer">
										<Trans>Viewer</Trans>
									</SelectItem>
									<SelectItem value="guest">
										<Trans>Guest</Trans>
									</SelectItem>
								</SelectContent>
							</Select>
						</div>

						<div className="space-y-2">
							<Label htmlFor="attributeMapping">
								<Trans>Attribute Mapping (JSON)</Trans>
							</Label>
							<Textarea
								id="attributeMapping"
								name="attributeMapping"
								placeholder={`{
				"email": "email",
				"name": "name",
				"firstName": "given_name",
				"lastName": "family_name",
				"department": "department"
				}`}
								rows={6}
								className="font-mono text-sm"
								defaultValue={existingConfig?.attributeMapping || ''}
							/>
							<p className="text-muted-foreground text-sm">
								<Trans>
									Map OIDC claims to user attributes. Leave empty for default
									mapping.
								</Trans>
							</p>
						</div>
					</CardContent>
				</Card>

				{/* Actions */}
				<div className="flex items-center justify-between">
					<div className="flex gap-2">
						<Button
							type="submit"
							name="intent"
							value="save"
							disabled={isSubmitting}
						>
							{isSubmitting ? (
								<>
									<Icon name="loader" className="mr-2 h-4 w-4 animate-spin" />
									<Trans>Saving...</Trans>
								</>
							) : (
								<>
									<Icon name="check" className="mr-2 h-4 w-4" />
									{existingConfig ? (
										<Trans>Update Configuration</Trans>
									) : (
										<Trans>Save Configuration</Trans>
									)}
								</>
							)}
						</Button>

						<Button
							type="submit"
							name="intent"
							value="test"
							variant="outline"
							disabled={isSubmitting}
						>
							{isSubmitting ? (
								<>
									<Icon name="loader" className="mr-2 h-4 w-4 animate-spin" />
									<Trans>Testing...</Trans>
								</>
							) : (
								<>
									<Icon name="plug" className="mr-2 h-4 w-4" />
									<Trans>Test Connection</Trans>
								</>
							)}
						</Button>
					</div>

					{existingConfig && (
						<Button
							type="submit"
							name="intent"
							value={existingConfig.isEnabled ? 'disable' : 'enable'}
							variant={existingConfig.isEnabled ? 'destructive' : 'default'}
							disabled={isSubmitting}
						>
							<Icon
								name={existingConfig.isEnabled ? 'ban' : 'check'}
								className="mr-2 h-4 w-4"
							/>
							{existingConfig.isEnabled ? (
								<Trans>Disable SSO</Trans>
							) : (
								<Trans>Enable SSO</Trans>
							)}
						</Button>
					)}
				</div>
			</Form>
		</div>
	)
}
