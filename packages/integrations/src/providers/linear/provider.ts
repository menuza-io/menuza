/**
 * Linear integration provider implementation
 */

import { getIntegrationUserAgent } from '@repo/config/brand'
import { ENV } from '../../package-env.js'

import {
	type Integration,
	type NoteIntegrationConnection,
} from '../../database-types'
import { BaseIntegrationProvider } from '../../provider'
import {
	type TokenData,
	type Channel,
	type MessageData,
	type OAuthCallbackParams,
} from '../../types'

const USER_AGENT = getIntegrationUserAgent()

/**
 * Linear API response interfaces
 */
interface LinearOAuthResponse {
	access_token: string
	token_type: string
	expires_in?: number
	scope?: string
	error?: string
	error_description?: string
}

interface LinearTeam {
	id: string
	name: string
	key: string
	description?: string
	color?: string
}

interface LinearProject {
	id: string
	name: string
	description?: string
	color?: string
	state: string
	teams: {
		nodes: LinearTeam[]
	}
}

interface LinearUser {
	id: string
	name: string
	displayName: string
	email: string
	avatarUrl?: string
}

interface LinearIssue {
	id: string
	identifier: string
	title: string
	description?: string
	url: string
	state: {
		name: string
		color: string
	}
	team: {
		id: string
		name: string
		key: string
	}
	project?: {
		id: string
		name: string
	}
}

interface LinearGraphQLResponse<T = any> {
	data?: T
	errors?: Array<{
		message: string
		extensions?: {
			code: string
		}
	}>
}

/**
 * Linear integration provider
 */
export class LinearProvider extends BaseIntegrationProvider {
	readonly name = 'linear'
	readonly type = 'productivity' as const
	readonly displayName = 'Linear'
	readonly description =
		'Connect notes to Linear teams and projects for issue tracking and project management'
	readonly logoPath = '/images/integrations/linear.svg'

	private readonly apiBaseUrl = 'https://api.linear.app'
	private readonly authBaseUrl = 'https://linear.app/oauth'

	/**
	 * Generate OAuth authorization URL for Linear
	 */
	async getAuthUrl(
		organizationId: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<string> {
		const clientId = ENV.LINEAR_CLIENT_ID
		if (!clientId) {
			throw new Error('LINEAR_CLIENT_ID environment variable is not set')
		}

		// Generate and store OAuth state
		const state = this.generateOAuthState(organizationId, {
			redirectUri,
			...additionalParams,
		})

		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			state,
			scope: 'read,write',
		})

		return `${this.authBaseUrl}/authorize?${params.toString()}`
	}

	/**
	 * Handle OAuth callback and exchange code for tokens
	 */
	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const { code, state, organizationId, error, errorDescription } = params

		if (error) {
			throw new Error(`OAuth error: ${errorDescription || error}`)
		}

		if (!code || !state) {
			throw new Error('Missing authorization code or state parameter')
		}

		// Verify OAuth state
		const stateData = this.parseOAuthState(state)
		if (stateData.organizationId !== organizationId) {
			throw new Error('Invalid OAuth state')
		}

		// Exchange code for access token (include redirectUri if available in state)
		const redirectUri = stateData.redirectUri as string | undefined
		const tokenResponse = await this.exchangeCodeForToken(code, redirectUri)

		// Note: Integration storage is handled by the calling code
		// This method only returns the token data

		return {
			accessToken: tokenResponse.access_token,
			expiresAt: tokenResponse.expires_in
				? new Date(Date.now() + tokenResponse.expires_in * 1000)
				: undefined,
			scope: tokenResponse.scope,
		}
	}

	/**
	 * Refresh expired access token
	 */
	async refreshToken(_refreshToken: string): Promise<TokenData> {
		// Linear doesn't currently support refresh tokens
		// Access tokens are long-lived (typically 1 year)
		throw new Error(
			'Linear does not support token refresh. Please re-authenticate.',
		)
	}

	/**
	 * Make an authenticated API call with proper token decryption
	 */
	private async makeAuthenticatedApiCall<T>(
		integration: Integration,
		apiCall: (accessToken: string) => Promise<T>,
	): Promise<T> {
		try {
			// Decrypt the stored access token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(integration.accessToken!)
			return await apiCall(accessToken)
		} catch (error) {
			// Check if it's an authentication error
			if (
				error instanceof Error &&
				(error.message.includes('Authentication required') ||
					error.message.includes('not authenticated'))
			) {
				throw new Error(
					'Linear access token is invalid or expired. ' +
						'Please disconnect and reconnect the Linear integration.',
				)
			}

			// Re-throw other errors
			throw error
		}
	}

	/**
	 * Get available teams/projects for the integration
	 */
	async getAvailableChannels(integration: Integration): Promise<Channel[]> {
		if (!integration.accessToken) {
			throw new Error('No access token found for integration')
		}

		try {
			// Get teams and projects using authenticated API calls
			const teams = await this.makeAuthenticatedApiCall(
				integration,
				(accessToken) => this.getTeams(accessToken),
			)
			const projects = await this.makeAuthenticatedApiCall(
				integration,
				(accessToken) => this.getProjects(accessToken),
			)

			const channels: Channel[] = []

			// Add teams as channels
			for (const team of teams) {
				channels.push({
					id: `team:${team.id}`,
					name: `${team.name} (Team)`,
					type: 'public',
					metadata: {
						type: 'team',
						teamId: team.id,
						teamKey: team.key,
						color: team.color,
						description: team.description,
					},
				})
			}

			// Add projects as channels
			for (const project of projects) {
				const teamNames = project.teams.nodes.map((t) => t.name).join(', ')
				channels.push({
					id: `project:${project.id}`,
					name: `${project.name} (Project)${teamNames ? ` - ${teamNames}` : ''}`,
					type: 'public',
					metadata: {
						type: 'project',
						projectId: project.id,
						state: project.state,
						color: project.color,
						teams: project.teams.nodes,
					},
				})
			}

			return channels.sort((a, b) => a.name.localeCompare(b.name))
		} catch (error) {
			console.error('Error fetching Linear channels:', error)
			throw new Error(
				`Failed to fetch Linear channels: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Post a message to a Linear team or project by creating an issue
	 */
	async postMessage(
		connection: NoteIntegrationConnection & { integration: Integration },
		message: MessageData,
	): Promise<void> {
		if (!connection.integration.accessToken) {
			throw new Error('No access token found for integration')
		}

		const channelId = connection.externalId // Use externalId from database schema

		// Determine if this is a team or project connection
		const isTeam = channelId.startsWith('team:')
		const isProject = channelId.startsWith('project:')

		if (!isTeam && !isProject) {
			throw new Error('Invalid channel type for Linear integration')
		}

		const actualId = channelId.replace(/^(team|project):/, '')

		// Create issue title with emoji based on change type
		const emoji = this.getChangeEmoji(message.changeType)
		const title = `${emoji} ${message.title}`

		// Create issue description
		const description = [
			`**Note:** ${message.title}`,
			`**Author:** ${message.author}`,
			`**Change:** ${message.changeType}`,
			'',
			'**Content:**',
			message.content,
			'',
			`**View Note:** ${message.noteUrl}`,
		].join('\n')

		if (isTeam) {
			// Create issue in team using authenticated API call
			await this.makeAuthenticatedApiCall(
				connection.integration,
				(accessToken) =>
					this.createIssueInTeam(accessToken, actualId, title, description),
			)
		} else {
			// Create issue in project using authenticated API call
			await this.makeAuthenticatedApiCall(
				connection.integration,
				(accessToken) =>
					this.createIssueInProject(accessToken, actualId, title, description),
			)
		}
	}

	/**
	 * Validate that the connection is still active
	 */
	async validateConnection(
		connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		try {
			if (!connection.integration.accessToken) {
				return false
			}

			const channelId = connection.externalId

			// Determine if this is a team or project connection
			const isTeam = channelId.startsWith('team:')
			const isProject = channelId.startsWith('project:')

			if (!isTeam && !isProject) {
				return false
			}

			const actualId = channelId.replace(/^(team|project):/, '')

			if (isTeam) {
				// Validate team exists and is accessible using authenticated API call
				const team = await this.makeAuthenticatedApiCall(
					connection.integration,
					(accessToken) => this.getTeam(accessToken, actualId),
				)
				return !!team
			} else {
				// Validate project exists and is accessible using authenticated API call
				const project = await this.makeAuthenticatedApiCall(
					connection.integration,
					(accessToken) => this.getProject(accessToken, actualId),
				)
				return !!project
			}
		} catch (error) {
			console.error('Linear connection validation failed:', error)
			return false
		}
	}

	/**
	 * Get emoji for change type
	 */
	protected getChangeEmoji(changeType: string): string {
		switch (changeType) {
			case 'created':
				return '✨'
			case 'updated':
				return '📝'
			case 'deleted':
				return '🗑️'
			case 'shared':
				return '🔗'
			default:
				return '📄'
		}
	}

	/**
	 * Get provider-specific configuration schema
	 */
	getConfigSchema(): Record<string, any> {
		return {
			type: 'object',
			properties: {
				includeNoteContent: {
					type: 'boolean',
					title: 'Include Note Content',
					description:
						'Include the full note content in the Linear issue description',
					default: true,
				},
				defaultIssueState: {
					type: 'string',
					title: 'Default Issue State',
					description:
						'Default state for created issues (e.g., "Todo", "In Progress")',
					default: 'Todo',
				},
				issuePriority: {
					type: 'string',
					title: 'Issue Priority',
					description: 'Priority level for created issues',
					enum: ['No priority', 'Urgent', 'High', 'Medium', 'Low'],
					default: 'No priority',
				},
			},
		}
	}

	// Private helper methods

	private async exchangeCodeForToken(
		code: string,
		redirectUri?: string,
	): Promise<LinearOAuthResponse> {
		const clientId = ENV.LINEAR_CLIENT_ID
		const clientSecret = ENV.LINEAR_CLIENT_SECRET

		if (!clientId || !clientSecret) {
			throw new Error(
				'LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET environment variables must be set',
			)
		}

		// Linear OAuth token endpoint
		const tokenUrl = 'https://api.linear.app/oauth/token'

		const requestBody = new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: clientId,
			client_secret: clientSecret,
			code,
		})

		// Add redirect_uri if provided (Linear requires it to match authorization request)
		if (redirectUri) {
			requestBody.append('redirect_uri', redirectUri)
		}

		const response = await fetch(tokenUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json',
				'User-Agent': USER_AGENT,
			},
			body: requestBody,
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(
				`Failed to exchange code for token: ${response.status} ${response.statusText}\n${errorText}`,
			)
		}

		const contentType = response.headers.get('content-type')
		if (!contentType?.includes('application/json')) {
			const responseText = await response.text()
			console.error(
				'Linear OAuth unexpected response type:',
				contentType,
				responseText.substring(0, 200),
			)
			throw new Error(
				`Expected JSON response but got ${contentType}. Response: ${responseText.substring(0, 200)}...`,
			)
		}

		try {
			const data = (await response.json()) as LinearOAuthResponse

			if (data.error) {
				throw new Error(
					`OAuth token exchange error: ${data.error_description || data.error}`,
				)
			}

			return data
		} catch (jsonError) {
			const responseText = await response.text()
			console.error(
				'Failed to parse Linear OAuth JSON response:',
				jsonError,
				responseText.substring(0, 200),
			)
			throw new Error(
				`Failed to parse OAuth response as JSON: ${jsonError}. Response: ${responseText.substring(0, 200)}...`,
			)
		}
	}

	private async makeGraphQLRequest<T = any>(
		accessToken: string,
		query: string,
		variables?: Record<string, any>,
	): Promise<T> {
		const response = await fetch(`${this.apiBaseUrl}/graphql`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
				'User-Agent': USER_AGENT,
			},
			body: JSON.stringify({
				query: query.trim(),
				variables,
			}),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(
				`Linear API request failed: ${response.status} ${response.statusText}\n${errorText}`,
			)
		}

		const data = (await response.json()) as LinearGraphQLResponse<T>

		if (data.errors && data.errors.length > 0) {
			throw new Error(
				`Linear GraphQL error: ${data.errors[0]?.message || 'Unknown error'}`,
			)
		}

		if (!data.data) {
			throw new Error('No data returned from Linear API')
		}

		return data.data
	}

	private async getCurrentUser(accessToken: string): Promise<LinearUser> {
		const query = `
			query {
				viewer {
					id
					name
					displayName
					email
					avatarUrl
				}
			}
		`

		const response = await this.makeGraphQLRequest<{ viewer: LinearUser }>(
			accessToken,
			query,
		)
		return response.viewer
	}

	private async getTeams(accessToken: string): Promise<LinearTeam[]> {
		const query = `
			query {
				teams {
					nodes {
						id
						name
						key
						description
						color
					}
				}
			}
		`

		const response = await this.makeGraphQLRequest<{
			teams: { nodes: LinearTeam[] }
		}>(accessToken, query)
		return response.teams.nodes
	}

	private async getTeam(
		accessToken: string,
		teamId: string,
	): Promise<LinearTeam> {
		const query = `
			query($teamId: String!) {
				team(id: $teamId) {
					id
					name
					key
					description
					color
				}
			}
		`

		const response = await this.makeGraphQLRequest<{ team: LinearTeam }>(
			accessToken,
			query,
			{ teamId },
		)
		return response.team
	}

	private async getProjects(accessToken: string): Promise<LinearProject[]> {
		const query = `
			query {
				projects {
					nodes {
						id
						name
						description
						color
						state
						teams {
							nodes {
								id
								name
								key
							}
						}
					}
				}
			}
		`

		const response = await this.makeGraphQLRequest<{
			projects: { nodes: LinearProject[] }
		}>(accessToken, query)
		return response.projects.nodes
	}

	private async getProject(
		accessToken: string,
		projectId: string,
	): Promise<LinearProject> {
		const query = `
			query($projectId: String!) {
				project(id: $projectId) {
					id
					name
					description
					color
					state
					teams {
						nodes {
							id
							name
							key
						}
					}
				}
			}
		`

		const response = await this.makeGraphQLRequest<{ project: LinearProject }>(
			accessToken,
			query,
			{ projectId },
		)
		return response.project
	}

	private async createIssueInTeam(
		accessToken: string,
		teamId: string,
		title: string,
		description: string,
	): Promise<LinearIssue> {
		const query = `
			mutation($input: IssueCreateInput!) {
				issueCreate(input: $input) {
					success
					issue {
						id
						identifier
						title
						description
						url
						state {
							name
							color
						}
						team {
							id
							name
							key
						}
						project {
							id
							name
						}
					}
				}
			}
		`

		const variables = {
			input: {
				teamId,
				title,
				description,
			},
		}

		const response = await this.makeGraphQLRequest<{
			issueCreate: {
				success: boolean
				issue: LinearIssue
			}
		}>(accessToken, query, variables)

		if (!response.issueCreate?.success) {
			throw new Error('Failed to create issue in Linear')
		}

		if (!response.issueCreate.issue) {
			throw new Error('No issue returned from Linear API')
		}

		return response.issueCreate.issue
	}

	private async createIssueInProject(
		accessToken: string,
		projectId: string,
		title: string,
		description: string,
	): Promise<LinearIssue> {
		// First get the project to find its teams
		const project = await this.getProject(accessToken, projectId)

		if (!project.teams.nodes.length) {
			throw new Error('Project has no associated teams')
		}

		// Use the first team for the issue
		const teamId = project.teams.nodes[0]?.id

		const query = `
			mutation($input: IssueCreateInput!) {
				issueCreate(input: $input) {
					success
					issue {
						id
						identifier
						title
						description
						url
						state {
							name
							color
						}
						team {
							id
							name
							key
						}
						project {
							id
							name
						}
					}
				}
			}
		`

		const variables = {
			input: {
				teamId,
				projectId,
				title,
				description,
			},
		}

		const response = await this.makeGraphQLRequest<{
			issueCreate: {
				success: boolean
				issue: LinearIssue
			}
		}>(accessToken, query, variables)

		if (!response.issueCreate?.success) {
			throw new Error('Failed to create issue in Linear project')
		}

		if (!response.issueCreate.issue) {
			throw new Error('No issue returned from Linear API')
		}

		return response.issueCreate.issue
	}

	private formatIssueTitle(message: MessageData): string {
		const prefix =
			message.changeType === 'created'
				? '📝'
				: message.changeType === 'updated'
					? '✏️'
					: '🗑️'

		return `${prefix} ${message.title}`
	}

	private formatIssueDescription(message: MessageData, config: any): string {
		const parts: string[] = []

		// Add note URL
		parts.push(`**Note:** [${message.title}](${message.noteUrl})`)

		// Add author
		parts.push(`**Author:** ${message.author}`)

		// Add change type
		const changeTypeText =
			message.changeType === 'created'
				? 'Created'
				: message.changeType === 'updated'
					? 'Updated'
					: 'Deleted'
		parts.push(`**Action:** ${changeTypeText}`)

		// Add content if enabled
		if (config.includeNoteContent !== false && message.content) {
			parts.push('')
			parts.push('**Content:**')
			parts.push(message.content)
		}

		return parts.join('\n')
	}
}
