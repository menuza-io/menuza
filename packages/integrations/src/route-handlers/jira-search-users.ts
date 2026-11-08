import { integrationManager, JiraProvider } from '../index'
import { type LoaderFunctionArgs } from 'react-router'
import {
	authorizeIntegration,
	type IntegrationRouteAuthDependencies,
} from './authorize-integration'

export type JiraSearchUsersDependencies = IntegrationRouteAuthDependencies

/**
 * Shared handler for searching Jira users.
 * Used by the bot user configuration UI.
 *
 * The member must be allowed to update the settings of the organization that
 * owns the integration (`update:settings:any`).
 *
 * @param request - The incoming request
 * @param params - Route params containing integrationId
 * @param deps - Dependencies (auth, membership, permission)
 * @returns JSON response with search results
 */
export async function handleJiraSearchUsers(
	{ request, params }: LoaderFunctionArgs,
	deps: JiraSearchUsersDependencies,
) {
	const userId = await deps.requireUserId(request)

	const integrationId = params.integrationId
	if (!integrationId) {
		return Response.json(
			{ error: 'Integration ID is required' },
			{ status: 400 },
		)
	}

	// Get search query from URL params
	const url = new URL(request.url)
	const query = url.searchParams.get('query')

	if (!query) {
		return Response.json({ error: 'Search query is required' }, { status: 400 })
	}

	try {
		const access = await authorizeIntegration(
			request,
			userId,
			integrationId,
			deps,
			'update:settings:any',
		)
		if ('status' in access && access.status === 403) {
			return Response.json(
				{
					error: 'Insufficient permissions to access Jira users',
				},
				{ status: 403 },
			)
		}
		if ('status' in access || access.integration.providerName !== 'jira') {
			return Response.json(
				{ error: 'Jira integration not found' },
				{ status: 404 },
			)
		}
		const { integration } = access

		// Get Jira provider
		const jiraProvider = integrationManager.getProvider('jira') as JiraProvider

		// Search for users
		const users = await jiraProvider.searchUsers(integration, query)

		return Response.json(users)
	} catch (error) {
		console.error('Error searching Jira users:', error)
		return Response.json(
			{
				error: `Failed to search users: ${error instanceof Error ? error.message : 'Unknown error'}`,
			},
			{ status: 500 },
		)
	}
}
