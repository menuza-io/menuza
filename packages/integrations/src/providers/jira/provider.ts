/**
 * Jira integration provider implementation
 */

import { ssrfSafeFetch } from '@repo/security'
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

/**
 * Jira API response interfaces
 */
interface JiraOAuthResponse {
	access_token: string
	refresh_token?: string
	expires_in?: number
	scope?: string
	error?: string
	error_description?: string
}

interface JiraProject {
	id: string
	key: string
	name: string
	projectTypeKey: string
	description?: string
	lead?: {
		accountId: string
		displayName: string
	}
	avatarUrls?: {
		'16x16': string
		'24x24': string
		'32x32': string
		'48x48': string
	}
}

interface JiraProjectsResponse {
	values: JiraProject[]
	total: number
	isLast: boolean
}

interface JiraIssueType {
	id: string
	name: string
	description: string
	iconUrl: string
	subtask: boolean
}

interface JiraCreateIssueResponse {
	id: string
	key: string
	self: string
}

interface JiraUser {
	accountId: string
	displayName: string
	emailAddress?: string
	avatarUrls?: {
		'16x16': string
		'24x24': string
		'32x32': string
		'48x48': string
	}
}

interface JiraCurrentUserResponse extends JiraUser {
	locale: string
	timeZone: string
}

/**
 * Jira integration provider
 */
export class JiraProvider extends BaseIntegrationProvider {
	readonly name = 'jira'
	readonly type = 'productivity' as const
	readonly displayName = 'Jira'
	readonly description =
		'Connect notes to Jira projects for issue tracking and project management'
	readonly logoPath = '/icons/jira.svg'

	constructor() {
		super()
	}

	private get clientId(): string {
		const clientId = ENV.JIRA_CLIENT_ID
		if (!clientId) {
			console.warn(
				'JIRA_CLIENT_ID not found in environment variables, using demo client ID',
			)
			return 'demo-jira-client-id'
		}
		return clientId
	}

	private get clientSecret(): string {
		const clientSecret = ENV.JIRA_CLIENT_SECRET
		if (!clientSecret) {
			console.warn(
				'JIRA_CLIENT_SECRET not found in environment variables, using demo client secret',
			)
			return 'demo-jira-client-secret'
		}
		return clientSecret
	}

	private async safeFetch(
		urlStr: string,
		init?: RequestInit,
	): Promise<Response> {
		return ssrfSafeFetch(urlStr, init)
	}

	private async getBaseUrl(
		integrationOrToken: Integration | string,
	): Promise<string> {
		let accessToken: string
		if (typeof integrationOrToken === 'string') {
			accessToken = integrationOrToken
		} else {
			const { decryptToken } = await import('../../encryption')
			accessToken = await decryptToken(integrationOrToken.accessToken!)
		}
		const cloudId = await this.getCloudId(accessToken)
		return `https://api.atlassian.com/ex/jira/${cloudId}`
	}

	/**
	 * Generate Jira OAuth authorization URL
	 */
	async getAuthUrl(
		organizationId: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<string> {
		const state = this.generateOAuthState(organizationId, {
			redirectUri,
			...additionalParams,
		})

		const params = new URLSearchParams({
			audience: 'api.atlassian.com',
			client_id: this.clientId,
			scope:
				'read:jira-work write:jira-work manage:jira-project read:me offline_access',
			redirect_uri: redirectUri,
			state,
			response_type: 'code',
			prompt: 'consent',
		})

		return `https://auth.atlassian.com/authorize?${params.toString()}`
	}

	/**
	 * Handle OAuth callback and exchange code for tokens
	 */
	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		if (params.error) {
			throw new Error(
				`Jira OAuth error: ${params.error} - ${params.errorDescription || 'Unknown error'}`,
			)
		}

		if (!params.code) {
			throw new Error('Authorization code is required')
		}

		// Validate state
		const stateData = this.parseOAuthState(params.state)
		if (!stateData.redirectUri) {
			throw new Error('Invalid OAuth state: missing redirect URI')
		}

		// Check if we have real Jira credentials
		const hasRealCredentials =
			this.clientId !== 'demo-jira-client-id' &&
			this.clientSecret !== 'demo-jira-client-secret' &&
			!this.clientId.startsWith('MOCK_') &&
			!this.clientSecret.startsWith('MOCK_')

		if (!hasRealCredentials) {
			return {
				accessToken: `mock-jira-token-${Date.now()}`,
				refreshToken: 'mock-jira-refresh-token',
				expiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour from now
				scope:
					'read:jira-work write:jira-work manage:jira-project read:me offline_access',
				metadata: {
					user: {
						account_id: '123456789012345678901234',
						display_name: 'Demo User',
						avatar_urls: {
							'24x24':
								'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/default-avatar-24.png',
							'32x32':
								'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/default-avatar-32.png',
							'48x48':
								'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/default-avatar-48.png',
						},
					},
					resources: [
						{
							id: '12345678-1234-1234-1234-123456789012',
							name: 'Demo Company',
							scopes: [
								'read:jira-work',
								'write:jira-work',
								'manage:jira-project',
							],
							avatarUrl:
								'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/default-avatar-24.png',
						},
					],
				},
			}
		}

		// Make real OAuth token exchange with Jira
		try {
			const tokenResponse = await this.safeFetch(
				'https://auth.atlassian.com/oauth/token',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json',
					},
					body: JSON.stringify({
						grant_type: 'authorization_code',
						client_id: this.clientId,
						client_secret: this.clientSecret,
						code: params.code,
						redirect_uri: stateData.redirectUri,
					}),
				},
			)

			if (!tokenResponse.ok) {
				const errorText = await tokenResponse.text()
				throw new Error(`Token exchange failed: ${errorText}`)
			}

			const tokenData = (await tokenResponse.json()) as JiraOAuthResponse

			if (tokenData.error) {
				throw new Error(
					`Token exchange error: ${tokenData.error_description || tokenData.error}`,
				)
			}

			if (!tokenData.access_token) {
				throw new Error('No access token received from Jira')
			}

			// Get user info and accessible resources
			const [userInfo, resources] = await Promise.all([
				this.getCurrentUser(tokenData.access_token),
				this.getAccessibleResources(tokenData.access_token),
			])

			const expiresAt = tokenData.expires_in
				? new Date(Date.now() + tokenData.expires_in * 1000)
				: undefined

			return {
				accessToken: tokenData.access_token,
				refreshToken: tokenData.refresh_token,
				expiresAt,
				scope: tokenData.scope,
				metadata: {
					user: userInfo,
					resources,
				},
			}
		} catch (error) {
			console.error('Jira OAuth callback error:', error)
			throw new Error(
				`Failed to complete Jira OAuth: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Refresh Jira access token
	 */
	async refreshToken(refreshToken: string): Promise<TokenData> {
		if (!refreshToken) {
			throw new Error('Refresh token is required')
		}

		try {
			const response = await this.safeFetch(
				'https://auth.atlassian.com/oauth/token',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json',
					},
					body: JSON.stringify({
						grant_type: 'refresh_token',
						client_id: this.clientId,
						client_secret: this.clientSecret,
						refresh_token: refreshToken,
					}),
				},
			)

			if (!response.ok) {
				const errorText = await response.text()
				throw new Error(`Token refresh failed: ${errorText}`)
			}

			const tokenData = (await response.json()) as JiraOAuthResponse

			if (tokenData.error) {
				throw new Error(
					`Token refresh error: ${tokenData.error_description || tokenData.error}`,
				)
			}

			const expiresAt = tokenData.expires_in
				? new Date(Date.now() + tokenData.expires_in * 1000)
				: undefined

			return {
				accessToken: tokenData.access_token,
				refreshToken: tokenData.refresh_token || refreshToken,
				expiresAt,
				scope: tokenData.scope,
			}
		} catch (error) {
			console.error('Jira token refresh error:', error)
			throw new Error(
				`Failed to refresh Jira token: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Get available Jira projects (mapped as channels for consistency)
	 */
	async getAvailableChannels(integration: Integration): Promise<Channel[]> {
		if (!integration.accessToken) {
			throw new Error('Access token is required')
		}

		// Check if this is a mock token (for demo purposes)
		if (integration.accessToken.startsWith('mock-jira-token-')) {
			return [
				{
					id: 'DEMO',
					name: 'DEMO - Demo Project',
					type: 'public',
					metadata: {
						key: 'DEMO',
						projectTypeKey: 'software',
						leadDisplayName: 'Demo User',
						description:
							'This is a demo project for testing integration features',
						demo: true,
					},
				},
				{
					id: 'TEST',
					name: 'TEST - Test Project',
					type: 'public',
					metadata: {
						key: 'TEST',
						projectTypeKey: 'business',
						leadDisplayName: 'Demo User',
						description: 'Another demo project for development purposes',
						demo: true,
					},
				},
			]
		}

		try {
			const projects = await this.makeAuthenticatedApiCall(
				integration,
				(accessToken) => this.getProjects(accessToken),
			)

			return projects.map((project) => ({
				id: project.key, // Use project key as channel ID
				name: `${project.key} - ${project.name}`,
				type: 'public' as const, // Jira projects are typically accessible to team members
				metadata: {
					projectId: project.id,
					projectKey: project.key,
					projectName: project.name,
					projectType: project.projectTypeKey,
					description: project.description,
					lead: project.lead,
					avatarUrls: project.avatarUrls,
				},
			}))
		} catch (error) {
			console.error('Error fetching Jira projects:', error)
			throw new Error(
				`Failed to fetch Jira projects: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Get the reporter account ID for issue creation
	 * Uses bot user if configured, otherwise falls back to connected user
	 */
	private getReporterAccountId(
		integration: Integration,
		connection?: NoteIntegrationConnection,
	): string {
		const config =
			typeof integration.config === 'string'
				? JSON.parse(integration.config)
				: (integration.config as any)
		const connectionConfig = connection
			? typeof connection.config === 'string'
				? JSON.parse(connection.config)
				: connection.config
			: (null as any)

		// Check connection-level bot user setting first
		if (connectionConfig?.reporterAccountId) {
			return connectionConfig.reporterAccountId
		}

		// Check integration-level bot user setting
		if (config.useBotUser && config.botUser?.accountId) {
			return config.botUser.accountId
		}

		// Fall back to connected user
		return config.user?.accountId
	}

	/**
	 * Configure bot user for this integration
	 */
	async configureBotUser(
		integration: Integration,
		botAccountId: string,
	): Promise<JiraUser> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const baseUrl = await this.getBaseUrl(accessToken)

			// Fetch bot user details from Jira
			const response = await this.safeFetch(
				`${baseUrl}/rest/api/3/user?accountId=${encodeURIComponent(botAccountId)}`,
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
						Accept: 'application/json',
					},
				},
			)

			if (!response.ok) {
				throw new Error(
					`Failed to fetch bot user details: ${response.statusText}`,
				)
			}
			const botUser = (await response.json()) as JiraUser
			return botUser
		})
	}

	/**
	 * Validate that a user account can be used as a bot user
	 */
	async validateBotUser(
		integration: Integration,
		botAccountId: string,
		projectKey: string,
	): Promise<{ valid: boolean; reason?: string }> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const baseUrl = await this.getBaseUrl(accessToken)

			try {
				// Check if bot user exists
				const userResponse = await this.safeFetch(
					`${baseUrl}/rest/api/3/user?accountId=${encodeURIComponent(botAccountId)}`,
					{
						headers: {
							Authorization: `Bearer ${accessToken}`,
							Accept: 'application/json',
						},
					},
				)

				if (!userResponse.ok) {
					return { valid: false, reason: 'Bot user account not found' }
				}

				// Check if bot user has permission to create issues in the project
				const permissionResponse = await this.safeFetch(
					`${baseUrl}/rest/api/3/user/permission/search?permissions=CREATE_ISSUES&projectKey=${encodeURIComponent(projectKey)}&accountId=${encodeURIComponent(botAccountId)}`,
					{
						headers: {
							Authorization: `Bearer ${accessToken}`,
							Accept: 'application/json',
						},
					},
				)

				if (!permissionResponse.ok) {
					return {
						valid: false,
						reason: 'Unable to verify bot user permissions',
					}
				}

				const permissions = (await permissionResponse.json()) as any[]

				const hasCreatePermission = permissions.some(
					(p: any) =>
						p.permission === 'CREATE_ISSUES' && p.havePermission === true,
				)

				if (!hasCreatePermission) {
					return {
						valid: false,
						reason:
							'Bot user does not have CREATE_ISSUES permission for this project',
					}
				}

				return { valid: true }
			} catch (error) {
				return {
					valid: false,
					reason: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
				}
			}
		})
	}

	/**
	 * Post a message to Jira (create an issue)
	 */
	async postMessage(
		connection: NoteIntegrationConnection & { integration: Integration },
		message: MessageData,
	): Promise<void> {
		if (!connection.integration.accessToken) {
			throw new Error('Access token is required')
		}

		if (!connection.externalId) {
			throw new Error('Project key is required')
		}

		// Check if this is a mock token (for demo purposes)
		if (connection.integration.accessToken.startsWith('mock-jira-token-')) {
			console.log(
				`[DEMO MODE] Would create Jira issue "${message.title}" in project ${connection.externalId}`,
			)
			return // Skip actual API call for mock/demo mode
		}

		try {
			const projectKey = connection.externalId
			const issueData = await this.formatJiraIssue(
				message,
				projectKey,
				connection.integration,
				connection,
			)

			await this.makeAuthenticatedApiCall(
				connection.integration,
				(accessToken) => this.createIssue(accessToken, issueData),
			)
		} catch (error) {
			console.error('Error posting message to Jira:', error)
			throw new Error(
				`Failed to create Jira issue: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Validate a Jira connection
	 */
	async validateConnection(
		connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		if (!connection.integration.accessToken) {
			return false
		}

		if (!connection.externalId) {
			return false
		}

		try {
			const projectKey = connection.externalId
			await this.makeAuthenticatedApiCall(
				connection.integration,
				(accessToken) => this.getProject(accessToken, projectKey),
			)
			return true
		} catch (error) {
			console.error('Jira connection validation failed:', error)
			return false
		}
	}

	/**
	 * Get Jira provider configuration schema
	 */
	getConfigSchema(): Record<string, any> {
		return {
			type: 'object',
			properties: {
				instanceUrl: {
					type: 'string',
					title: 'Jira Instance URL',
					description:
						'Your Jira Cloud instance URL (e.g., https://yourcompany.atlassian.net)',
					pattern: '^https://[a-zA-Z0-9-]+\\.atlassian\\.net/?$',
				},
				defaultIssueType: {
					type: 'string',
					title: 'Default Issue Type',
					description:
						'Default issue type for created issues (e.g., Task, Story, Bug)',
					default: 'Task',
				},
				includeNoteContent: {
					type: 'boolean',
					title: 'Include Note Content',
					description: 'Include the full note content in the issue description',
					default: true,
				},
			},
			required: ['instanceUrl'],
		}
	}

	// Private helper methods

	/**
	 * Get current user information
	 */
	private async getCurrentUser(
		accessToken: string,
	): Promise<JiraCurrentUserResponse> {
		const response = await this.safeFetch('https://api.atlassian.com/me', {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
			},
		})

		if (!response.ok) {
			throw new Error(`Failed to get user info: ${response.statusText}`)
		}

		return (await response.json()) as JiraCurrentUserResponse
	}

	/**
	 * Make an authenticated API call with automatic token refresh
	 */
	private async makeAuthenticatedApiCall<T>(
		integration: Integration,
		apiCall: (accessToken: string) => Promise<T>,
	): Promise<T> {
		try {
			// Try with current token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(integration.accessToken!)
			return await apiCall(accessToken)
		} catch (error) {
			// Check if it's an authorization error
			if (error instanceof Error && error.message.includes('Unauthorized')) {
				try {
					// Import integration manager to refresh tokens
					const { integrationManager } =
						await import('../../integration-manager')

					// Try to refresh tokens if refresh token is available
					if (integration.refreshToken) {
						const refreshedIntegration =
							await integrationManager.refreshIntegrationTokens(integration.id)

						// Try again with refreshed token
						const { decryptToken } = await import('../../encryption')
						const newAccessToken = await decryptToken(
							refreshedIntegration.accessToken!,
						)
						return await apiCall(newAccessToken)
					} else {
						// If no refresh token is available, throw a more helpful error
						throw new Error(
							'Jira access token expired and no refresh token is available. ' +
								'Please disconnect and reconnect the Jira integration.',
						)
					}
				} catch (refreshError) {
					console.error('Token refresh failed:', refreshError)
					throw new Error(
						`Authentication failed and token refresh failed: ` +
							`${refreshError instanceof Error ? refreshError.message : 'Unknown error'}. ` +
							`You may need to disconnect and reconnect your Jira integration.`,
					)
				}
			}

			// Re-throw non-auth errors
			throw error
		}
	}

	/**
	 * Get accessible Jira resources
	 */
	private async getAccessibleResources(accessToken: string): Promise<any[]> {
		const response = await this.safeFetch(
			'https://api.atlassian.com/oauth/token/accessible-resources',
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
			},
		)

		if (!response.ok) {
			throw new Error(
				`Failed to get accessible resources: ${response.statusText}`,
			)
		}

		return (await response.json()) as any[]
	}

	/**
	 * Get Jira projects
	 */
	private async getProjects(accessToken: string): Promise<JiraProject[]> {
		const baseUrl = await this.getBaseUrl(accessToken)

		const response = await this.safeFetch(
			`${baseUrl}/rest/api/3/project/search?expand=lead,description`,
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
			},
		)

		if (!response.ok) {
			throw new Error(`Failed to get projects: ${response.statusText}`)
		}

		const data = (await response.json()) as JiraProjectsResponse
		return data.values
	}

	/**
	 * Get a specific Jira project
	 */
	private async getProject(
		accessToken: string,
		projectKey: string,
	): Promise<JiraProject> {
		const baseUrl = await this.getBaseUrl(accessToken)

		const response = await this.safeFetch(
			`${baseUrl}/rest/api/3/project/${projectKey}?expand=lead,description`,
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
			},
		)

		if (!response.ok) {
			throw new Error(`Failed to get project: ${response.statusText}`)
		}

		return (await response.json()) as JiraProject
	}

	/**
	 * Get available issue types for a project
	 */
	private async getProjectIssueTypes(
		accessToken: string,
		projectKey: string,
	): Promise<JiraIssueType[]> {
		const baseUrl = await this.getBaseUrl(accessToken)

		const response = await this.safeFetch(
			`${baseUrl}/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`,
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
			},
		)

		if (!response.ok) {
			throw new Error(`Failed to get issue types: ${response.statusText}`)
		}

		const data = (await response.json()) as any

		const project = (data as any).projects?.[0]
		if (!project || !project.issuetypes) {
			throw new Error('No issue types found for project')
		}

		return project.issuetypes.filter(
			(issueType: JiraIssueType) => !issueType.subtask,
		)
	}

	/**
	 * Create a Jira issue
	 */
	private async createIssue(
		accessToken: string,
		issueData: any,
	): Promise<JiraCreateIssueResponse> {
		const baseUrl = await this.getBaseUrl(accessToken)

		const response = await this.safeFetch(`${baseUrl}/rest/api/3/issue`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify(issueData),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Failed to create issue: ${errorText}`)
		}

		return (await response.json()) as JiraCreateIssueResponse
	}

	/**
	 * Get current user details from Jira
	 * Public method for UI utilities
	 */
	async getCurrentUserDetails(
		integration: Integration,
	): Promise<JiraCurrentUserResponse> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const baseUrl = await this.getBaseUrl(accessToken)
			const response = await this.safeFetch(`${baseUrl}/rest/api/3/myself`, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
			})

			if (!response.ok) {
				throw new Error(`Failed to fetch user details: ${response.statusText}`)
			}

			return (await response.json()) as JiraCurrentUserResponse
		})
	}

	/**
	 * Search for Jira users
	 * Public method for UI utilities to find bot users
	 */
	async searchUsers(
		integration: Integration,
		query: string,
	): Promise<JiraUser[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const baseUrl = await this.getBaseUrl(accessToken)
			const url = new URL(`${baseUrl}/rest/api/3/user/search`)
			url.searchParams.append('query', query)

			// Make API request to search users
			const response = await this.safeFetch(url.toString(), {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
			})

			if (!response.ok) {
				throw new Error(`Failed to search users: ${response.statusText}`)
			}

			return (await response.json()) as JiraUser[]
		})
	}

	/**
	 * Get cloud ID for Jira API calls
	 */
	private async getCloudId(accessToken: string): Promise<string> {
		const resources = await this.getAccessibleResources(accessToken)
		const jiraResource = resources[0]
		if (!jiraResource) {
			throw new Error('No accessible Jira resource found')
		}

		return jiraResource.id
	}

	/**
	 * Format message data as Jira issue
	 */
	private async formatJiraIssue(
		message: MessageData,
		projectKey: string,
		integration: Integration,
		connection?: NoteIntegrationConnection,
	): Promise<any> {
		const config =
			typeof integration.config === 'string'
				? JSON.parse(integration.config)
				: (integration.config as any)
		const includeContent = config?.includeNoteContent !== false
		const preferredIssueType = config?.defaultIssueType || 'Task'

		// Get available issue types for the project
		let issueType: string
		try {
			const availableIssueTypes = await this.makeAuthenticatedApiCall(
				integration,
				(accessToken) => this.getProjectIssueTypes(accessToken, projectKey),
			)

			// Try to find the preferred issue type first
			const preferredType = availableIssueTypes.find(
				(type) => type.name.toLowerCase() === preferredIssueType.toLowerCase(),
			)

			if (preferredType) {
				issueType = preferredType.name
			} else {
				// Fallback to the first available issue type
				issueType = availableIssueTypes[0]?.name || 'Task'
			}
		} catch {
			issueType = 'Task' // Final fallback
		}

		let summary = message.title
		if (message.changeType !== 'created') {
			summary = `[${message.changeType.toUpperCase()}] ${summary}`
		}

		let description = `Note ${message.changeType} by ${message.author}`

		if (message.noteUrl) {
			description += `\n\n[View Note|${message.noteUrl}]`
		}

		if (includeContent && message.content) {
			description += `\n\n---\n\n${message.content}`
		}

		// Get the reporter account ID (bot user or connected user)
		const _reporterAccountId = this.getReporterAccountId(
			integration,
			connection,
		)

		return {
			fields: {
				project: {
					key: projectKey,
				},
				summary: this.truncateText(summary, 255), // Jira summary has a 255 character limit
				description: {
					type: 'doc',
					version: 1,
					content: [
						{
							type: 'paragraph',
							content: [
								{
									type: 'text',
									text: description,
								},
							],
						},
					],
				},
				issuetype: {
					name: issueType,
				},
				// reporter: {
				// 	accountId: reporterAccountId,
				// },
			},
		}
	}

	/**
	 * Truncate text to specified length
	 */
	protected truncateText(text: string, maxLength: number): string {
		if (text.length <= maxLength) {
			return text
		}
		return text.substring(0, maxLength - 3) + '...'
	}
}
