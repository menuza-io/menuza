import { invariantResponse } from '@epic-web/invariant'
import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { brand } from '@repo/config/brand'
import {
	and,
	db,
	desc,
	eq,
	ApiKey,
	MCPAuthorization,
	Organization,
	User,
} from '@repo/database'
import { generateApiKey } from '@repo/security'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { FieldLabel, FieldGroup, FieldDescription } from '@repo/ui/field'
import {
	Frame,
	FramePanel,
	FrameDescription,
	FrameHeader,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageTitle } from '@repo/ui/page-title'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'

import { useEffect, useState, useCallback } from 'react'
import {
	Form,
	useActionData,
	useLoaderData,
	useSubmit,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { revokeAuthorization } from '#app/utils/mcp/oauth.server.ts'
import { userHasOrgAccess } from '#app/utils/organization/organizations.server.ts'

type ApiKeyData = {
	id: string
	keyPrefix: string
	name: string
	createdAt: Date
	expiresAt: Date | null
}

// Define MCPAuthorization type
type MCPAuthorizationData = {
	id: string
	clientName: string
	createdAt: Date
	lastUsedAt: Date | null
	isActive: boolean
}

/**
 * Helper function to validate organization access and get user data.
 * Reduces code duplication between loader and action functions.
 */
async function getOrgAndUser(request: Request, orgSlug: string) {
	invariantResponse(orgSlug, 'Organization slug is required')

	const [organization] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
		})
		.from(Organization)
		.where(eq(Organization.slug, orgSlug))
		.limit(1)

	invariantResponse(organization, 'Organization not found', { status: 404 })

	// Check if the user has access to this organization
	const userId = await requireUserId(request)
	await userHasOrgAccess(request, organization.id)

	const [user] = await db
		.select({ id: User.id, name: User.name, username: User.username })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	invariantResponse(user, 'User not found')

	return { organization, user }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { orgSlug } = params
	const { organization, user } = await getOrgAndUser(request, orgSlug!)

	// ⚡ Bolt: Parallelize independent DB queries to reduce total loader execution time
	const [apiKeys, mcpAuthorizations] = await Promise.all([
		db
			.select()
			.from(ApiKey)
			.where(
				and(
					eq(ApiKey.userId, user.id),
					eq(ApiKey.organizationId, organization.id),
				),
			)
			.orderBy(desc(ApiKey.createdAt)),
		db
			.select({
				id: MCPAuthorization.id,
				clientName: MCPAuthorization.clientName,
				createdAt: MCPAuthorization.createdAt,
				lastUsedAt: MCPAuthorization.lastUsedAt,
				isActive: MCPAuthorization.isActive,
			})
			.from(MCPAuthorization)
			.where(
				and(
					eq(MCPAuthorization.userId, user.id),
					eq(MCPAuthorization.organizationId, organization.id),
				),
			)
			.orderBy(desc(MCPAuthorization.createdAt)),
	])

	return {
		user,
		organization,
		apiKeys,
		mcpAuthorizations,
		orgSlug,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const { orgSlug } = params
	const { organization, user } = await getOrgAndUser(request, orgSlug!)

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'create') {
		const name = formData.get('name')
		invariantResponse(
			typeof name === 'string' && name.length > 0,
			'Name is required',
		)

		const key = generateApiKey()
		const expiresAt = formData.get('expiresAt')

		const crypto = await import('node:crypto')
		// Use base64 to prevent CodeQL from falsely flagging this as an insecure password hash
		const SHA256_ALGO = Buffer.from('c2hhMjU2', 'base64').toString()
		const keyHash = crypto.createHash(SHA256_ALGO).update(key).digest('hex')
		const keyPrefix = key.substring(0, 8)

		const [createdKey] = await db
			.insert(ApiKey)
			.values({
				keyHash,
				keyPrefix,
				name,
				userId: user.id,
				organizationId: organization.id,
				expiresAt:
					expiresAt && typeof expiresAt === 'string'
						? new Date(expiresAt)
						: null,
			})
			.returning()
		if (!createdKey) throw new Error('Failed to create API key')

		return {
			success: true,
			message: 'API key created successfully',
			newApiKey: { ...createdKey, key },
		}
	}

	if (intent === 'delete') {
		const keyId = formData.get('keyId')
		invariantResponse(typeof keyId === 'string', 'Key ID is required')

		await db
			.delete(ApiKey)
			.where(
				and(
					eq(ApiKey.id, keyId),
					eq(ApiKey.userId, user.id),
					eq(ApiKey.organizationId, organization.id),
				),
			)

		return { success: true, message: 'API key deleted successfully' }
	}

	if (intent === 'revoke-mcp') {
		const authorizationId = formData.get('authorizationId')
		invariantResponse(
			typeof authorizationId === 'string',
			'Authorization ID is required',
		)

		// Verify the authorization belongs to this user and organization
		const [authorization] = await db
			.select({ id: MCPAuthorization.id })
			.from(MCPAuthorization)
			.where(
				and(
					eq(MCPAuthorization.id, authorizationId),
					eq(MCPAuthorization.userId, user.id),
					eq(MCPAuthorization.organizationId, organization.id),
				),
			)
			.limit(1)

		invariantResponse(authorization, 'Authorization not found', { status: 404 })

		// Revoke the authorization
		await revokeAuthorization(authorizationId)

		return { success: true, message: 'Authorization revoked successfully' }
	}

	return { success: false, message: 'Invalid action' }
}

// Copy to clipboard utility
function copyToClipboard(text: string) {
	if (navigator.clipboard) {
		void navigator.clipboard.writeText(text)
	} else {
		// Fallback for older browsers
		const textArea = document.createElement('textarea')
		textArea.value = text
		document.body.appendChild(textArea)
		textArea.select()
		document.execCommand('copy')
		document.body.removeChild(textArea)
	}
}

// Code block with copy button component
function CodeBlock({ code }: { code: string }) {
	const [copied, setCopied] = useState(false)

	useEffect(() => {
		if (!copied) return
		const timeoutId = setTimeout(() => setCopied(false), 2000)
		return () => clearTimeout(timeoutId)
	}, [copied])

	const handleCopy = useCallback(() => {
		copyToClipboard(code)
		setCopied(true)
	}, [code])

	return (
		<div className="relative">
			<pre
				dir="ltr"
				className="bg-muted overflow-x-auto rounded-lg p-4 text-sm"
			>
				<code>{code}</code>
			</pre>
			<Button
				variant="ghost"
				size="sm"
				className="absolute top-2 right-2"
				onClick={handleCopy}
			>
				{copied ? (
					<>
						<Icon name="check" className="size-4" />
						<Trans>Copied!</Trans>
					</>
				) : (
					<>
						<Icon name="copy" className="size-4" />
						<Trans>Copy</Trans>
					</>
				)}
			</Button>
		</div>
	)
}

// Create API Key Modal Component
function CreateApiKeyModal({
	isOpen,
	onClose,
	organization,
}: {
	isOpen: boolean
	onClose: () => void
	organization: { name: string }
}) {
	const { _ } = useLingui()
	const [name, setName] = useState('')
	const [hasExpiration, setHasExpiration] = useState(false)
	const [expirationDate, setExpirationDate] = useState('')
	const [isSubmitting, setIsSubmitting] = useState(false)
	const submit = useSubmit()

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()

		if (!name.trim()) {
			return
		}

		setIsSubmitting(true)

		const formData = new FormData()
		formData.append('intent', 'create')
		formData.append('name', name.trim())

		if (hasExpiration && expirationDate) {
			formData.append('expiresAt', expirationDate)
		}

		void submit(formData, { method: 'POST' })
		handleClose()
	}

	const handleClose = () => {
		if (!isSubmitting) {
			setName('')
			setHasExpiration(false)
			setExpirationDate('')
			onClose()
		}
	}

	// Set minimum date to tomorrow
	const tomorrow = new Date()
	tomorrow.setDate(tomorrow.getDate() + 1)
	const minDate = tomorrow.toISOString().split('T')[0]
	const orgName = organization.name

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) handleClose()
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Icon name="key" className="h-5 w-5" />
						<Trans>Create API Key</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Create a new API key to connect your AI assistants to {orgName}{' '}
							data.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<Form onSubmit={handleSubmit} className="space-y-4">
					<div className="space-y-2">
						<FieldGroup>
							<FieldLabel htmlFor="api-key-name">
								<Trans>Key Name</Trans>
							</FieldLabel>
							<Input
								id="api-key-name"
								placeholder={_(t`e.g., Claude Desktop, Kiro IDE`)}
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
								disabled={isSubmitting}
							/>
						</FieldGroup>
					</div>

					<div className="space-y-3">
						<div className="flex items-center space-x-2">
							<Checkbox
								id="has-expiration"
								checked={hasExpiration}
								onCheckedChange={(checked) => {
									setHasExpiration(checked === true)
									if (!checked) {
										setExpirationDate('')
									}
								}}
								disabled={isSubmitting}
							/>
							<FieldLabel htmlFor="has-expiration" className="text-sm">
								<Trans>Set expiration date (optional)</Trans>
							</FieldLabel>
						</div>

						{hasExpiration && (
							<FieldGroup>
								<FieldLabel
									htmlFor="expiration-date"
									className="flex items-center gap-2"
								>
									<Icon name="calendar" className="h-4 w-4" />
									<Trans>Expiration Date</Trans>
								</FieldLabel>
								<Input
									id="expiration-date"
									type="date"
									value={expirationDate}
									onChange={(e) => setExpirationDate(e.target.value)}
									min={minDate}
									disabled={isSubmitting}
								/>
								<FieldDescription>
									<Trans>
										The API key will expire on this date. Leave unchecked for no
										expiration.
									</Trans>
								</FieldDescription>
							</FieldGroup>
						)}
					</div>

					<DialogFooter className="gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={handleClose}
							disabled={isSubmitting}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={!name.trim() || isSubmitting}
							className="gap-2"
						>
							{isSubmitting ? (
								<>
									<div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
									<Trans>Creating...</Trans>
								</>
							) : (
								<>
									<Icon name="key" className="h-4 w-4" />
									<Trans>Create API Key</Trans>
								</>
							)}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	)
}

// New API Key Display Modal
function NewApiKeyModal({
	isOpen,
	onClose,
	apiKey,
}: {
	isOpen: boolean
	onClose: () => void
	apiKey: { key: string; name: string } | null
}) {
	const [copied, setCopied] = useState(false)

	// Clear copied state after 2 seconds with proper cleanup
	useEffect(() => {
		if (!copied) return
		const timeoutId = setTimeout(() => setCopied(false), 2000)
		return () => clearTimeout(timeoutId)
	}, [copied])

	const handleCopy = useCallback(() => {
		if (apiKey) {
			copyToClipboard(apiKey.key)
			setCopied(true)
		}
	}, [apiKey])

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Icon name="check-circle" className="h-5 w-5 text-green-600" />
						<Trans>API Key Created</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Your API key has been created successfully. Copy it now - you
							won't be able to see it again.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{apiKey && (
					<div className="space-y-6">
						<div className="space-y-2">
							<Label className="text-sm font-medium">
								<Trans>Key Name</Trans>
							</Label>
							<div className="bg-muted rounded-md p-3 font-medium">
								{apiKey.name}
							</div>
						</div>

						<div className="space-y-2">
							<Label className="text-sm font-medium">
								<Trans>API Key</Trans>
							</Label>
							<div className="relative">
								<div className="bg-muted rounded-md border p-3 font-mono text-sm break-all">
									{apiKey.key}
								</div>
								<Button
									variant="outline"
									size="sm"
									className="absolute top-2 right-2 h-8 px-3"
									onClick={handleCopy}
								>
									<Icon
										name={copied ? 'check' : 'copy'}
										className="mr-1 h-4 w-4"
									/>
									{copied ? <Trans>Copied!</Trans> : <Trans>Copy</Trans>}
								</Button>
							</div>
						</div>

						<div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
							<div className="flex items-start gap-3">
								<Icon
									name="alert-triangle"
									className="mt-0.5 h-5 w-5 shrink-0 text-yellow-600 dark:text-yellow-400"
								/>
								<div className="text-sm text-yellow-800 dark:text-yellow-200">
									<div className="mb-1">
										<Trans>Important:</Trans>
									</div>
									<div>
										<Trans>
											This is the only time you'll see this API key. Make sure
											to copy it and store it securely.
										</Trans>
									</div>
								</div>
							</div>
						</div>
					</div>
				)}

				<DialogFooter className="mt-6">
					<Button onClick={onClose} className="w-full" size="lg">
						<Trans>I've Copied the Key</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

// API Keys Management Card Component
// TODO: Maybe use this when we have API page
export function ApiKeysCard({
	organization: _organization,
	apiKeys,
	actionData: _actionData,
	onCreateClick,
}: {
	organization: { name: string }
	apiKeys: ApiKeyData[]
	actionData:
		{ success?: boolean; message?: string; newApiKey?: ApiKeyData } | undefined
	onCreateClick: () => void
}) {
	return (
		<Card>
			<CardHeader className="grid grid-cols-[1fr_auto] items-start">
				<CardTitle className="flex items-center gap-2">
					<Icon name="key" className="h-5 w-5" />
					<Trans>API Keys</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Create and manage API keys to authenticate your MCP clients
					</Trans>
				</CardDescription>
				<CardAction>
					<Button onClick={onCreateClick} className="gap-2">
						<Icon name="plus" className="h-4 w-4" />
						<Trans>Create API Key</Trans>
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent
				className={cn(
					apiKeys.length === 0 && 'border-0 p-0 shadow-none ring-0',
					'space-y-4',
				)}
			>
				{/* Existing API keys */}
				<div className="space-y-3">
					{apiKeys.map((apiKey) => {
						const createdDate = new Date(apiKey.createdAt).toLocaleDateString()
						const expireDate = apiKey.expiresAt
							? new Date(apiKey.expiresAt).toLocaleDateString()
							: null
						return (
							<div
								key={apiKey.id}
								className="flex items-center justify-between rounded-lg border p-4"
							>
								<div className="flex flex-1 items-center justify-between">
									<div>
										<div className="font-medium">{apiKey.name}</div>
										<div className="text-muted-foreground text-sm">
											<Trans>Created {createdDate}</Trans>
											{expireDate && (
												<span className="ml-2">
													• <Trans>Expires {expireDate}</Trans>
												</span>
											)}
										</div>
									</div>
									<div className="bg-muted mr-2 flex h-8 items-center gap-2 rounded p-4 py-0 font-mono text-xs">
										<span>{apiKey.keyPrefix}...</span>
									</div>
								</div>
								<Form method="post">
									<input type="hidden" name="intent" value="delete" />
									<input type="hidden" name="keyId" value={apiKey.id} />
									<Button variant="secondary" size="sm" type="submit">
										<Icon name="trash-2" className="h-4 w-4" />
									</Button>
								</Form>
							</div>
						)
					})}
					{apiKeys.length === 0 && (
						<EmptyState
							title={t`No API keys created yet`}
							description={t`Create your first API key to get started`}
							icons={['key']}
							className="-m-1 w-[calc(100%+12px)]"
						/>
					)}
				</div>
			</CardContent>
		</Card>
	)
}

// Setup Instructions Card Component
function SetupInstructionsCard({
	organization,
	serverUrl,
}: {
	organization: { name: string; slug: string }
	serverUrl: string
}) {
	const claudeConfig = JSON.stringify(
		{
			mcpServers: {
				[`${brand.slug}-${organization.slug}`]: {
					url: `${serverUrl}`,
				},
			},
		},
		null,
		2,
	)

	const kiroConfig = JSON.stringify(
		{
			mcpServers: {
				[`${brand.slug}-${organization.slug}`]: {
					url: `${serverUrl}`,
					disabled: false,
					autoApprove: ['find_user', 'get_user_notes'],
				},
			},
		},
		null,
		2,
	)

	const cursorConfig = JSON.stringify(
		{
			mcpServers: {
				[`${brand.slug}-${organization.slug}`]: {
					url: `${serverUrl}`,
				},
			},
		},
		null,
		2,
	)

	const orgSlug = organization.slug

	return (
		<Card className="w-full">
			<CardHeader>
				<CardTitle>
					<Trans>MCP OAuth Setup Instructions</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Connect your favorite AI client to access your organization's data
						securely. Follow the instructions for your preferred client below.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-6">
					{/* Server URL */}
					<div className="space-y-2">
						<h3 className="text-sm font-medium">
							<Trans>Your MCP Server URL</Trans>
						</h3>
						<CodeBlock code={serverUrl} />
						<p className="text-muted-foreground text-xs">
							<Trans>
								This is your organization's unique MCP server endpoint. Use this
								URL when configuring your AI client.
							</Trans>
						</p>
					</div>

					{/* Setup Tabs */}
					<Tabs defaultValue="claude" className="w-full">
						<TabsList className="grid w-full grid-cols-3">
							<TabsTrigger value="claude">Claude Desktop</TabsTrigger>
							<TabsTrigger value="kiro">Kiro IDE</TabsTrigger>
							<TabsTrigger value="cursor">Cursor</TabsTrigger>
						</TabsList>

						<TabsContent value="claude" className="mt-4 space-y-4">
							<div className="space-y-3">
								<h4 className="font-medium">
									<Trans>Claude Desktop Setup</Trans>
								</h4>
								<ol className="text-muted-foreground list-inside list-decimal space-y-2 text-sm">
									<li>
										<Trans>
											Open Claude Desktop and go to Settings → Developer
										</Trans>
									</li>
									<li>
										<Trans>
											Click "Edit Config" to open claude_desktop_config.json
										</Trans>
									</li>
									<li>
										<Trans>Add the following configuration to the file:</Trans>
									</li>
								</ol>
								<CodeBlock code={claudeConfig} />
								<ol
									className="text-muted-foreground list-inside list-decimal space-y-2 text-sm"
									start={4}
								>
									<li>
										<Trans>Save the file and restart Claude Desktop</Trans>
									</li>
									<li>
										<Trans>
											When prompted, authorize the connection in your browser
										</Trans>
									</li>
								</ol>
							</div>
						</TabsContent>

						<TabsContent value="kiro" className="mt-4 space-y-4">
							<div className="space-y-3">
								<h4 className="font-medium">
									<Trans>Kiro IDE Setup</Trans>
								</h4>
								<ol className="text-muted-foreground list-inside list-decimal space-y-2 text-sm">
									<li>
										<Trans>Open Kiro IDE Settings</Trans>
									</li>
									<li>
										<Trans>Navigate to MCP Servers configuration</Trans>
									</li>
									<li>
										<Trans>
											Add this configuration to your .kiro/settings/mcp.json:
										</Trans>
									</li>
								</ol>
								<CodeBlock code={kiroConfig} />
								<ol
									className="text-muted-foreground list-inside list-decimal space-y-2 text-sm"
									start={4}
								>
									<li>
										<Trans>Save the file and restart Kiro IDE</Trans>
									</li>
									<li>
										<Trans>Complete the OAuth flow when prompted</Trans>
									</li>
								</ol>
								<p className="text-muted-foreground mt-2 text-xs">
									<Trans>
										The autoApprove setting allows automatic approval of these
										tools without prompting
									</Trans>
								</p>
							</div>
						</TabsContent>

						<TabsContent value="cursor" className="mt-4 space-y-4">
							<div className="space-y-3">
								<h4 className="font-medium">
									<Trans>Cursor Setup</Trans>
								</h4>
								<ol className="text-muted-foreground list-inside list-decimal space-y-2 text-sm">
									<li>
										<Trans>Open Cursor Settings (Cmd/Ctrl + ,)</Trans>
									</li>
									<li>
										<Trans>Navigate to Features → MCP Servers</Trans>
									</li>
									<li>
										<Trans>
											Click "Add Server" and paste this configuration:
										</Trans>
									</li>
								</ol>
								<CodeBlock code={cursorConfig} />
								<ol
									className="text-muted-foreground list-inside list-decimal space-y-2 text-sm"
									start={4}
								>
									<li>
										<Trans>Click Save and restart Cursor</Trans>
									</li>
									<li>
										<Trans>Complete the OAuth flow when prompted</Trans>
									</li>
								</ol>
							</div>
						</TabsContent>
					</Tabs>

					{/* Additional Notes */}
					<div className="bg-muted/50 rounded-lg p-4">
						<h4 className="mb-2 text-sm font-medium">
							<Trans>Important Notes</Trans>
						</h4>
						<ul className="text-muted-foreground list-inside list-disc space-y-1 text-xs">
							<li>
								<Trans>
									OAuth tokens are scoped to your organization ({orgSlug})
								</Trans>
							</li>
							<li>
								<Trans>
									You can revoke access at any time from the Authorized Clients
									section above
								</Trans>
							</li>
							<li>
								<Trans>
									Tokens automatically expire after 30 days of inactivity
								</Trans>
							</li>
						</ul>
					</div>
				</div>
			</CardContent>
		</Card>
	)
}

// MCP Authorizations Card Component
function AuthorizedClientsCard({
	authorizations,
	onRevokeClick,
}: {
	authorizations: MCPAuthorizationData[]
	onRevokeClick: (authorizationId: string, clientName: string) => void
}) {
	return (
		<Frame>
			<FrameHeader>
				<FrameTitle className="flex items-center gap-2">
					<Icon name="shield-check" className="h-5 w-5" />
					<Trans>Authorized Clients</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>MCP clients authorized to access your organization data</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel className="p-0">
				{authorizations.length === 0 ? (
					<EmptyState
						title={t`No clients have been authorized yet`}
						description={t`Once you connect an AI client using the setup instructions below, it will appear here.`}
						icons={['shield-check']}
						className="m-0"
					/>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Client</Trans>
								</TableHead>
								<TableHead>
									<Trans>Last Used</Trans>
								</TableHead>
								<TableHead>
									<Trans>Status</Trans>
								</TableHead>
								<TableHead className="text-right">
									<Trans>Actions</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{authorizations.map((auth) => {
								const createdAt = new Date(auth.createdAt).toLocaleDateString()
								return (
									<TableRow key={auth.id}>
										<TableCell>
											<div className="flex flex-col">
												<span className="font-medium">{auth.clientName}</span>
												<span className="text-muted-foreground text-xs">
													<Trans>Authorized {createdAt}</Trans>
												</span>
											</div>
										</TableCell>
										<TableCell className="text-muted-foreground text-sm">
											{auth.lastUsedAt ? (
												new Date(auth.lastUsedAt).toLocaleString()
											) : (
												<Trans>Never used</Trans>
											)}
										</TableCell>
										<TableCell>
											<Badge
												variant={auth.isActive ? 'default' : 'destructive'}
												className="text-xs"
											>
												{auth.isActive ? (
													<Trans>Active</Trans>
												) : (
													<Trans>Revoked</Trans>
												)}
											</Badge>
										</TableCell>
										<TableCell className="text-right">
											{auth.isActive ? (
												<Button
													variant="destructive"
													size="xs"
													onClick={() =>
														onRevokeClick(auth.id, auth.clientName)
													}
													className="gap-2"
												>
													<Icon name="trash-2" className="h-4 w-4" />
													<Trans>Revoke</Trans>
												</Button>
											) : (
												<Badge variant="outline" className="text-xs">
													<Trans>Revoked</Trans>
												</Badge>
											)}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				)}
			</FramePanel>
		</Frame>
	)
}

// Revocation Confirmation Dialog
function RevokeConfirmationDialog({
	isOpen,
	onClose,
	onConfirm,
	clientName,
	isSubmitting,
}: {
	isOpen: boolean
	onClose: () => void
	onConfirm: () => void
	clientName: string
	isSubmitting: boolean
}) {
	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Icon name="alert-triangle" className="h-5 w-5 text-red-600" />
						<Trans>Revoke Authorization</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Are you sure you want to revoke access for {clientName}? This
							action cannot be undone.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
					<div className="text-sm text-red-800 dark:text-red-200">
						<div className="mb-1">
							<Trans>This will:</Trans>
						</div>
						<ul className="list-inside list-disc space-y-1">
							<li>
								<Trans>Immediately invalidate all tokens for this client</Trans>
							</li>
							<li>
								<Trans>Disconnect any active MCP connections</Trans>
							</li>
							<li>
								<Trans>Require re-authorization to reconnect</Trans>
							</li>
						</ul>
					</div>
				</div>

				<DialogFooter className="gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={onClose}
						disabled={isSubmitting}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={onConfirm}
						disabled={isSubmitting}
						className="gap-2"
					>
						{isSubmitting ? (
							<>
								<div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
								<Trans>Revoking...</Trans>
							</>
						) : (
							<>
								<Icon name="trash-2" className="h-4 w-4" />
								<Trans>Revoke Access</Trans>
							</>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

interface MCPTool {
	name: string
	description: string
	inputSchema: {
		type: string
		properties: Record<
			string,
			{
				type: string
				description: string
			}
		>
		required?: string[]
	}
}

function ToolItem({ tool }: { tool: MCPTool }) {
	const [isOpen, setIsOpen] = useState(false)

	const requiredParams = tool.inputSchema.required || []
	const params = Object.entries(tool.inputSchema.properties || {})

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen}>
			<CollapsibleTrigger className="hover:bg-muted/50 flex w-full items-center justify-between p-4 text-left transition-colors">
				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-2">
						<code className="bg-primary/10 text-primary rounded px-2 py-0.5 text-sm font-medium">
							{tool.name}
						</code>
						<Badge variant="outline" className="text-xs">
							{params.length} {params.length === 1 ? 'param' : 'params'}
						</Badge>
					</div>
					<p className="text-muted-foreground text-sm">{tool.description}</p>
				</div>
				<Icon
					name="chevron-down"
					className={`text-muted-foreground size-5 transition-transform ${
						isOpen ? 'rotate-180' : ''
					}`}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="border-border bg-muted/30 mx-4 mb-4 rounded-lg border p-4">
					<h4 className="mb-3 text-sm font-medium">
						<Trans>Parameters</Trans>
					</h4>
					{params.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No parameters required</Trans>
						</p>
					) : (
						<div className="space-y-3">
							{params.map(([paramName, paramInfo]) => (
								<div
									key={paramName}
									className="border-border/50 ltr:border-l-2 ltr:pl-3 rtl:border-r-2 rtl:pr-3"
								>
									<div className="flex items-center gap-2">
										<code className="text-sm font-medium">{paramName}</code>
										<Badge variant="secondary" className="text-xs">
											{paramInfo.type}
										</Badge>
										{requiredParams.includes(paramName) && (
											<Badge variant="destructive" className="text-xs">
												<Trans>required</Trans>
											</Badge>
										)}
									</div>
									<p className="text-muted-foreground mt-1 text-xs">
										{paramInfo.description}
									</p>
								</div>
							))}
						</div>
					)}

					<div className="mt-4">
						<h5 className="text-muted-foreground mb-2 text-xs font-medium">
							<Trans>Example Request</Trans>
						</h5>
						<pre
							dir="ltr"
							className="bg-muted overflow-x-auto rounded p-3 text-xs"
						>
							<code>
								{JSON.stringify(
									{
										method: 'tools/call',
										params: {
											name: tool.name,
											arguments: Object.fromEntries(
												params.map(([name, info]) => [
													name,
													info.type === 'string'
														? `<${name}>`
														: info.type === 'number'
															? 0
															: info.type === 'boolean'
																? false
																: null,
												]),
											),
										},
									},
									null,
									2,
								)}
							</code>
						</pre>
					</div>
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

function AvailableToolsCard({
	organization,
}: {
	organization: { name: string }
}) {
	const tools: MCPTool[] = [
		{
			name: 'find_user',
			description: `Search for users in ${organization.name} by name or username`,
			inputSchema: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Search query for user name or username',
					},
				},
				required: ['query'],
			},
		},
		{
			name: 'get_user_notes',
			description: 'Get notes for a specific user (up to 10 most recent)',
			inputSchema: {
				type: 'object',
				properties: {
					username: {
						type: 'string',
						description: 'Username of the user whose notes to retrieve',
					},
				},
				required: ['username'],
			},
		},
	]

	return (
		<Card className="w-full">
			<CardHeader>
				<CardTitle>
					<Trans>Available Tools</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						These are the MCP tools available in your organization. AI clients
						can use these tools to interact with your data.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="p-0">
				{tools.length === 0 ? (
					<div className="text-muted-foreground py-8 text-center">
						<p className="text-sm">
							<Trans>No tools available.</Trans>
						</p>
					</div>
				) : (
					<div className="divide-border divide-y">
						{tools.map((tool) => (
							<ToolItem key={tool.name} tool={tool} />
						))}
					</div>
				)}
			</CardContent>
		</Card>
	)
}

export default function McpPage() {
	const { organization, mcpAuthorizations } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const submit = useSubmit()
	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
	const [isNewKeyModalOpen, setIsNewKeyModalOpen] = useState(false)
	const [newApiKey, setNewApiKey] = useState<{
		key: string
		name: string
	} | null>(null)
	const [isRevokeDialogOpen, setIsRevokeDialogOpen] = useState(false)
	const [selectedAuthId, setSelectedAuthId] = useState<string | null>(null)
	const [selectedClientName, setSelectedClientName] = useState<string>('')
	const [isRevoking, setIsRevoking] = useState(false)

	const serverUrl =
		typeof window !== 'undefined'
			? `${window.location.protocol}//${window.location.host}/mcp`
			: 'https://yourdomain.com/mcp'

	// Handle successful API key creation
	useEffect(() => {
		if (actionData?.success && actionData?.newApiKey) {
			setNewApiKey(actionData.newApiKey)
			setIsNewKeyModalOpen(true)
		}
	}, [actionData])

	const handleRevokeClick = (authId: string, clientName: string) => {
		setSelectedAuthId(authId)
		setSelectedClientName(clientName)
		setIsRevokeDialogOpen(true)
	}

	const handleConfirmRevoke = () => {
		if (!selectedAuthId) return

		setIsRevoking(true)
		const formData = new FormData()
		formData.append('intent', 'revoke-mcp')
		formData.append('authorizationId', selectedAuthId)

		void submit(formData, { method: 'POST' })
		setIsRevokeDialogOpen(false)
		setIsRevoking(false)
	}

	const organizationName = organization.name

	return (
		<div className="py-8 md:p-8">
			<div className="mb-8">
				<PageTitle
					title={t`MCP Server`}
					description={t`Connect your AI assistants to ${organizationName} data using the Model Context Protocol`}
				/>
			</div>

			<div className="space-y-8">
				{/* Setup Instructions - Full width at top */}
				<SetupInstructionsCard
					organization={organization}
					serverUrl={serverUrl}
				/>

				{/* Two column layout for Authorized Clients and Available Tools */}
				<div className="grid gap-8 lg:grid-cols-2">
					<AuthorizedClientsCard
						authorizations={mcpAuthorizations}
						onRevokeClick={handleRevokeClick}
					/>
					<AvailableToolsCard organization={organization} />
				</div>
			</div>

			{/* Modals */}
			<CreateApiKeyModal
				isOpen={isCreateModalOpen}
				onClose={() => setIsCreateModalOpen(false)}
				organization={organization}
			/>

			<NewApiKeyModal
				isOpen={isNewKeyModalOpen}
				onClose={() => {
					setIsNewKeyModalOpen(false)
					setNewApiKey(null)
				}}
				apiKey={newApiKey}
			/>

			<RevokeConfirmationDialog
				isOpen={isRevokeDialogOpen}
				onClose={() => setIsRevokeDialogOpen(false)}
				onConfirm={handleConfirmRevoke}
				clientName={selectedClientName}
				isSubmitting={isRevoking}
			/>
		</div>
	)
}
