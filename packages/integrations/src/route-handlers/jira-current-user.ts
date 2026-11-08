import { integrationManager, JiraProvider } from '../index'
import { type LoaderFunctionArgs } from 'react-router'
import {
	authorizeIntegration,
	type IntegrationRouteAuthDependencies,
} from './authorize-integration'

export type JiraCurrentUserDependencies = IntegrationRouteAuthDependencies

/**
 * Shared handler for getting the current Jira user.
 * Used by the bot user configuration UI.
 *
 * The member must be allowed to update the settings of the organization that
 * owns the integration (`update:settings:any`).
 *
 * @param request - The incoming request
 * @param params - Route params containing integrationId
 * @param deps - Dependencies (auth, membership, permission)
 * @returns JSON response with current user info
 */
export async function handleJiraCurrentUser(
	{ request, params }: LoaderFunctionArgs,
	deps: JiraCurrentUserDependencies,
) {
	const userId = await deps.requireUserId(request)

	const integrationId = params.integrationId
	if (!integrationId) {
		return Response.json(
			{ error: 'Integration ID is required' },
			{ status: 400 },
		)
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
					error: 'Insufficient permissions to access Jira user details',
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

		// Get current user details
		const userDetails = await jiraProvider.getCurrentUserDetails(integration)

		return Response.json(userDetails)
	} catch (error) {
		console.error('Error getting current Jira user:', error)
		return Response.json(
			{
				error: `Failed to get current user: ${error instanceof Error ? error.message : 'Unknown error'}`,
			},
			{ status: 500 },
		)
	}
}
