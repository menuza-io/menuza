import { Integration as IntegrationTable, and, db, eq } from '@repo/database'
import { integrationManager, JiraProvider } from '../index'
import { type ActionFunctionArgs } from 'react-router'
import { pinGitLabInstanceUrl } from '../providers/gitlab/instance-pin.js'

export interface UpdateConfigDependencies {
	requireUserId: (request: Request) => Promise<string>
	getUserDefaultOrganization: (
		userId: string,
	) => Promise<{ organization: { id: string } } | null>
	requireOrgPermission?: (
		request: Request,
		organizationId: string,
		permission: `${string}:${string}:${string}`,
	) => Promise<void>
}

/**
 * Shared handler for updating integration configuration.
 * Used by the Jira bot user settings UI.
 * Used by both the admin and app applications.
 *
 * @param request - The incoming request
 * @param deps - Dependencies (auth, org utils)
 * @returns JSON response with updated integration
 */
export async function handleUpdateIntegrationConfig(
	{ request }: ActionFunctionArgs,
	deps: UpdateConfigDependencies,
) {
	const userId = await deps.requireUserId(request)
	const defaultOrg = await deps.getUserDefaultOrganization(userId)

	if (!defaultOrg) {
		return Response.json(
			{ error: 'No organization found for user' },
			{ status: 403 },
		)
	}

	if (deps.requireOrgPermission) {
		try {
			await deps.requireOrgPermission(
				request,
				defaultOrg.organization.id,
				'update:settings:any',
			)
		} catch {
			return Response.json(
				{
					error: 'Insufficient permissions to update integration configuration',
				},
				{ status: 403 },
			)
		}
	}

	const formData = await request.formData()
	const intent = formData.get('intent')

	// Check for the correct intent
	if (intent !== 'update-integration-config') {
		return Response.json({ error: 'Invalid intent' }, { status: 400 })
	}

	const integrationId = formData.get('integrationId')
	if (!integrationId || typeof integrationId !== 'string') {
		return Response.json(
			{ error: 'Integration ID is required' },
			{ status: 400 },
		)
	}

	const configString = formData.get('config')
	if (!configString || typeof configString !== 'string') {
		return Response.json({ error: 'Config is required' }, { status: 400 })
	}

	let config: any
	try {
		config = JSON.parse(configString)
	} catch {
		return Response.json({ error: 'Invalid config JSON' }, { status: 400 })
	}

	try {
		// Verify the integration belongs to this organization
		const [integration] = await db
			.select()
			.from(IntegrationTable)
			.where(
				and(
					eq(IntegrationTable.id, integrationId),
					eq(IntegrationTable.organizationId, defaultOrg.organization.id),
				),
			)
			.limit(1)

		if (!integration) {
			return Response.json({ error: 'Integration not found' }, { status: 404 })
		}

		// Validate Jira configuration instanceUrl / siteUrl before saving
		if (integration.providerName === 'jira') {
			const instanceUrl = config.instanceUrl ?? config.siteUrl
			if (instanceUrl !== undefined) {
				const jiraUrlPattern = /^https:\/\/[a-zA-Z0-9-]+\.atlassian\.net\/?$/
				if (
					typeof instanceUrl !== 'string' ||
					!jiraUrlPattern.test(instanceUrl)
				) {
					return Response.json(
						{
							error:
								'Invalid Jira instance URL. Must be a valid Atlassian Cloud domain.',
						},
						{ status: 400 },
					)
				}
			}
		}

		if (integration.providerName === 'gitlab') {
			const pinned = pinGitLabInstanceUrl(integration.config, config)
			if ('error' in pinned) {
				return Response.json({ error: pinned.error }, { status: 400 })
			}
			config = pinned.config
		}

		// Special handling for Jira bot user configuration
		if (integration.providerName === 'jira' && 'useBotUser' in config) {
			// Validate bot user if enabled
			if (config.useBotUser && config.botUser?.accountId) {
				// Get Jira provider
				const jiraProvider = integrationManager.getProvider(
					'jira',
				) as JiraProvider

				try {
					// Fetch bot user to validate it exists
					await jiraProvider.configureBotUser(
						integration,
						config.botUser.accountId,
					)
				} catch (error) {
					console.error('Error validating bot user:', error)
					return Response.json(
						{
							error: `Invalid bot user: ${error instanceof Error ? error.message : 'Unknown error'}`,
						},
						{ status: 400 },
					)
				}
			}
		}

		// Update the integration config
		const [updatedIntegration] = await db
			.update(IntegrationTable)
			.set({
				config: JSON.stringify(config),
			})
			.where(eq(IntegrationTable.id, integrationId))
			.returning()

		return Response.json({ success: true, integration: updatedIntegration })
	} catch (error) {
		console.error('Error updating integration config:', error)
		return Response.json(
			{
				error: `Failed to update config: ${error instanceof Error ? error.message : 'Unknown error'}`,
			},
			{ status: 500 },
		)
	}
}
