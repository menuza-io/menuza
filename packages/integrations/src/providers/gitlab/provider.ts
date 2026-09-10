/**
 * GitLab integration provider implementation
 */

import { ssrfSafeFetch, validateInstanceUrl } from '@repo/security'
import { ENV } from '../../package-env.ts'
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
 * GitLab API response interfaces
 */
interface GitLabOAuthResponse {
	access_token: string
	refresh_token?: string
	expires_in?: number
	scope?: string
	token_type: string
	error?: string
	error_description?: string
}

interface GitLabProject {
	id: number
	name: string
	name_with_namespace: string
	path: string
	path_with_namespace: string
	description?: string
	default_branch: string
	visibility: 'private' | 'internal' | 'public'
	web_url: string
	avatar_url?: string
	namespace: {
		id: number
		name: string
		path: string
		kind: 'user' | 'group'
	}
	permissions: {
		project_access?: {
			access_level: number
		}
		group_access?: {
			access_level: number
		}
	}
}

interface GitLabUser {
	id: number
	username: string
	name: string
	email?: string
	avatar_url?: string
	web_url: string
	state: 'active' | 'blocked'
}

// Unused interface - kept for future extensibility
// interface GitLabIssue {
// 	id: number
// 	iid: number
// 	title: string
// 	description?: string
// 	state: 'opened' | 'closed'
// 	web_url: string
// 	author: GitLabUser
// 	assignees: GitLabUser[]
// 	labels: string[]
// 	milestone?: {
// 		id: number
// 		title: string
// 	}
// 	project_id: number
// 	created_at: string
// 	updated_at: string
// }

interface GitLabCreateIssueResponse {
	id: number
	iid: number
	title: string
	description?: string
	web_url: string
	project_id: number
}

interface GitLabLabel {
	id: number
	name: string
	color: string
	description?: string
}

interface GitLabMilestone {
	id: number
	title: string
	description?: string
	state: 'active' | 'closed'
	web_url: string
}

/**
 * GitLab integration provider
 */
export class GitLabProvider extends BaseIntegrationProvider {
	readonly name = 'gitlab'
	readonly type = 'productivity' as const
	readonly displayName = 'GitLab'
	readonly description =
		'Connect notes to GitLab projects for issue tracking and project management'
	readonly logoPath = '/icons/gitlab.svg'

	private readonly apiBaseUrl = 'https://gitlab.com/api/v4'
	private readonly authBaseUrl = 'https://gitlab.com/oauth'

	constructor() {
		super()
	}

	private get clientId(): string {
		const clientId = ENV.GITLAB_CLIENT_ID
		if (!clientId) {
			throw new Error('GITLAB_CLIENT_ID environment variable is required')
		}
		return clientId
	}

	private get clientSecret(): string {
		const clientSecret = ENV.GITLAB_CLIENT_SECRET
		if (!clientSecret) {
			throw new Error('GITLAB_CLIENT_SECRET environment variable is required')
		}
		return clientSecret
	}

	private getBaseUrl(integration?: Integration): string {
		// Support for self-hosted GitLab instances
		const config = integration?.config
			? typeof integration.config === 'string'
				? JSON.parse(integration.config)
				: integration.config
			: null
		const instanceUrl = (config as any)?.instanceUrl as string

		if (instanceUrl) {
			const validation = validateInstanceUrl(instanceUrl)
			if (!validation.valid) {
				throw new Error(`SSRF security validation failed: ${validation.reason}`)
			}
			return instanceUrl.endsWith('/')
				? `${instanceUrl}api/v4`
				: `${instanceUrl}/api/v4`
		}

		return this.apiBaseUrl
	}

	/**
	 * Generate GitLab OAuth authorization URL
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
			client_id: this.clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			state,
			scope: 'api read_user read_repository write_repository',
		})

		// Support custom GitLab instances
		const instanceUrl = additionalParams?.instanceUrl as string
		const authUrl = instanceUrl
			? `${instanceUrl}/oauth/authorize`
			: `${this.authBaseUrl}/authorize`

		return `${authUrl}?${params.toString()}`
	}

	/**
	 * Handle OAuth callback and exchange code for tokens
	 */
	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		if (params.error) {
			throw new Error(
				`GitLab OAuth error: ${params.error} - ${params.errorDescription || 'Unknown error'}`,
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

		// Support custom GitLab instances
		const instanceUrl = stateData.instanceUrl as string
		const tokenUrl = instanceUrl
			? `${instanceUrl}/oauth/token`
			: `${this.authBaseUrl}/token`

		try {
			const tokenResponse = await ssrfSafeFetch(tokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: JSON.stringify({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					code: params.code,
					grant_type: 'authorization_code',
					redirect_uri: stateData.redirectUri,
				}),
			})

			if (!tokenResponse.ok) {
				const errorText = await tokenResponse.text()
				throw new Error(`Token exchange failed: ${errorText}`)
			}

			const tokenData = (await tokenResponse.json()) as GitLabOAuthResponse

			if (tokenData.error) {
				throw new Error(
					`Token exchange error: ${tokenData.error_description || tokenData.error}`,
				)
			}

			if (!tokenData.access_token) {
				throw new Error('No access token received from GitLab')
			}

			// Get user info to store in config
			const userInfo = await this.getCurrentUser(
				tokenData.access_token,
				instanceUrl,
			)

			// Calculate expiration date
			const expiresAt = tokenData.expires_in
				? new Date(Date.now() + tokenData.expires_in * 1000)
				: undefined

			return {
				accessToken: tokenData.access_token,
				refreshToken: tokenData.refresh_token,
				expiresAt,
				scope: tokenData.scope,
				metadata: {
					instanceUrl: instanceUrl || 'https://gitlab.com',
					user: {
						id: userInfo.id,
						username: userInfo.username,
						name: userInfo.name,
						email: userInfo.email,
						avatarUrl: userInfo.avatar_url,
					},
				},
			}
		} catch (error) {
			throw new Error(
				`GitLab OAuth callback failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Refresh GitLab access token
	 */
	async refreshToken(refreshToken: string): Promise<TokenData> {
		if (!refreshToken) {
			throw new Error('Refresh token is required')
		}

		try {
			const tokenResponse = await fetch(`${this.authBaseUrl}/token`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: JSON.stringify({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					refresh_token: refreshToken,
					grant_type: 'refresh_token',
				}),
			})

			if (!tokenResponse.ok) {
				const errorText = await tokenResponse.text()
				throw new Error(`Token refresh failed: ${errorText}`)
			}

			const tokenData = (await tokenResponse.json()) as GitLabOAuthResponse

			if (tokenData.error) {
				throw new Error(
					`Token refresh error: ${tokenData.error_description || tokenData.error}`,
				)
			}

			if (!tokenData.access_token) {
				throw new Error('No access token received from GitLab')
			}

			// Calculate expiration date
			const expiresAt = tokenData.expires_in
				? new Date(Date.now() + tokenData.expires_in * 1000)
				: undefined

			return {
				accessToken: tokenData.access_token,
				refreshToken: tokenData.refresh_token || refreshToken, // Keep old refresh token if new one not provided
				expiresAt,
				scope: tokenData.scope,
			}
		} catch (error) {
			throw new Error(
				`GitLab token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Get available GitLab projects (mapped as channels for consistency)
	 */
	async getAvailableChannels(integration: Integration): Promise<Channel[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const projects = await this.getProjects(accessToken, integration)

			return projects.map((project): Channel => ({
				id: project.id.toString(),
				name: project.name_with_namespace,
				type: project.visibility === 'private' ? 'private' : 'public',
				metadata: {
					projectId: project.id,
					projectPath: project.path_with_namespace,
					description: project.description,
					webUrl: project.web_url,
					avatarUrl: project.avatar_url,
					defaultBranch: project.default_branch,
					namespace: project.namespace,
				},
			}))
		})
	}

	/**
	 * Post a message to GitLab (create an issue)
	 */
	async postMessage(
		connection: NoteIntegrationConnection & { integration: Integration },
		message: MessageData,
	): Promise<void> {
		await this.makeAuthenticatedApiCall(
			connection.integration,
			async (accessToken) => {
				const config =
					typeof connection.config === 'string'
						? JSON.parse(connection.config)
						: (connection.config as any)

				const projectId = config?.projectId || connection.externalId
				if (!projectId) {
					throw new Error('Project ID is required for GitLab integration')
				}

				const issueData = await this.formatGitLabIssue(
					message,
					projectId,
					connection.integration,
					connection,
				)
				await this.createIssue(
					accessToken,
					projectId,
					issueData,
					connection.integration,
				)
			},
		)
	}

	/**
	 * Validate a GitLab connection
	 */
	async validateConnection(
		connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		try {
			return await this.makeAuthenticatedApiCall(
				connection.integration,
				async (accessToken) => {
					const config =
						typeof connection.config === 'string'
							? JSON.parse(connection.config)
							: (connection.config as any)

					const projectId = config?.projectId || connection.externalId
					if (!projectId) {
						return false
					}

					// Try to get the project to validate access
					const project = await this.getProject(
						accessToken,
						projectId,
						connection.integration,
					)
					return !!project
				},
			)
		} catch (error) {
			console.error('GitLab connection validation failed:', error)
			return false
		}
	}

	/**
	 * Get GitLab provider configuration schema
	 */
	getConfigSchema(): Record<string, any> {
		return {
			type: 'object',
			properties: {
				instanceUrl: {
					type: 'string',
					title: 'GitLab Instance URL',
					description:
						'Custom GitLab instance URL (leave empty for gitlab.com)',
					format: 'uri',
				},
				user: {
					type: 'object',
					properties: {
						id: { type: 'number' },
						username: { type: 'string' },
						name: { type: 'string' },
						email: { type: 'string' },
						avatarUrl: { type: 'string' },
					},
					required: ['id', 'username', 'name'],
				},
			},
		}
	}

	/**
	 * Get current user information
	 */
	async getCurrentUser(
		accessToken: string,
		instanceUrl?: string,
	): Promise<GitLabUser> {
		const baseUrl = instanceUrl ? `${instanceUrl}/api/v4` : this.apiBaseUrl
		const url = `${baseUrl}/user`

		const response = await ssrfSafeFetch(url, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
			},
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(
				`Failed to get GitLab user: ${response.statusText} - ${errorText}`,
			)
		}

		const userData = (await response.json()) as GitLabUser
		return userData
	}

	/**
	 * Make an authenticated API call with automatic token refresh
	 */
	private async makeAuthenticatedApiCall<T>(
		integration: Integration,
		apiCall: (accessToken: string) => Promise<T>,
	): Promise<T> {
		try {
			if (!integration.accessToken) {
				throw new Error('No access token available for GitLab integration')
			}
			// Decrypt the access token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(integration.accessToken)
			return await apiCall(accessToken)
		} catch (error) {
			// If token is expired, try to refresh it
			if (error instanceof Error && error.message.includes('401')) {
				if (!integration.refreshToken) {
					throw new Error('Access token expired and no refresh token available')
				}

				try {
					const newTokenData = await this.refreshToken(integration.refreshToken)

					// Update the integration with new tokens (this would typically be done by the calling code)
					integration.accessToken = newTokenData.accessToken
					if (newTokenData.refreshToken) {
						integration.refreshToken = newTokenData.refreshToken
					}
					if (newTokenData.expiresAt) {
						integration.tokenExpiresAt = newTokenData.expiresAt
					}

					// Retry the API call with the new token (already decrypted)
					return await apiCall(newTokenData.accessToken)
				} catch (refreshError) {
					throw new Error(
						`Token refresh failed: ${refreshError instanceof Error ? refreshError.message : 'Unknown error'}`,
					)
				}
			}

			throw error
		}
	}

	/**
	 * Get GitLab projects
	 */
	private async getProjects(
		accessToken: string,
		integration: Integration,
	): Promise<GitLabProject[]> {
		const baseUrl = this.getBaseUrl(integration)
		const url = `${baseUrl}/projects?membership=true&per_page=100&order_by=last_activity_at`

		const response = await ssrfSafeFetch(url, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
			},
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(
				`Failed to get GitLab projects: ${response.statusText} - ${errorText}`,
			)
		}

		return (await response.json()) as GitLabProject[]
	}

	/**
	 * Get a specific GitLab project
	 */
	private async getProject(
		accessToken: string,
		projectId: string,
		integration: Integration,
	): Promise<GitLabProject> {
		const baseUrl = this.getBaseUrl(integration)

		const response = await ssrfSafeFetch(
			`${baseUrl}/projects/${encodeURIComponent(projectId)}`,
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
			},
		)

		if (!response.ok) {
			throw new Error(`Failed to get GitLab project: ${response.statusText}`)
		}

		return (await response.json()) as GitLabProject
	}

	/**
	 * Create a GitLab issue
	 */
	private async createIssue(
		accessToken: string,
		projectId: string,
		issueData: any,
		integration: Integration,
	): Promise<GitLabCreateIssueResponse> {
		const baseUrl = this.getBaseUrl(integration)

		const response = await ssrfSafeFetch(
			`${baseUrl}/projects/${encodeURIComponent(projectId)}/issues`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: JSON.stringify(issueData),
			},
		)

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Failed to create GitLab issue: ${errorText}`)
		}

		return (await response.json()) as GitLabCreateIssueResponse
	}

	/**
	 * Format message data as GitLab issue
	 */
	private async formatGitLabIssue(
		message: MessageData,
		projectId: string,
		integration: Integration,
		connection?: NoteIntegrationConnection,
	): Promise<any> {
		const config = connection?.config
			? typeof connection.config === 'string'
				? JSON.parse(connection.config)
				: connection.config
			: ({} as any)

		const includeContent = config.includeNoteContent !== false
		const labels = config.defaultLabels || []

		let description = `**Note by ${message.author}**\n\n`

		if (includeContent && message.content) {
			// Truncate content if too long (GitLab has a limit)
			const truncatedContent = this.truncateText(message.content, 50000)
			description += `${truncatedContent}\n\n`
		}

		description += `[View full note](${message.noteUrl})`

		const issueData: any = {
			title: this.truncateText(message.title, 255),
			description,
		}

		// Add labels if configured
		if (labels.length > 0) {
			issueData.labels = labels.join(',')
		}

		// Add milestone if configured
		if (config.milestoneId) {
			issueData.milestone_id = config.milestoneId
		}

		// Add assignee if configured
		if (config.assigneeId) {
			issueData.assignee_id = config.assigneeId
		}

		return issueData
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

	/**
	 * Get current user details from GitLab
	 * Public method for UI utilities
	 */
	async getCurrentUserDetails(integration: Integration): Promise<GitLabUser> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			return this.getCurrentUser(accessToken, this.getInstanceUrl(integration))
		})
	}

	/**
	 * Get project labels
	 * Public method for UI utilities
	 */
	async getProjectLabels(
		integration: Integration,
		projectId: string,
	): Promise<GitLabLabel[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const baseUrl = this.getBaseUrl(integration)

			const response = await ssrfSafeFetch(
				`${baseUrl}/projects/${encodeURIComponent(projectId)}/labels`,
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
						Accept: 'application/json',
					},
				},
			)

			if (!response.ok) {
				throw new Error(
					`Failed to get GitLab project labels: ${response.statusText}`,
				)
			}

			return (await response.json()) as GitLabLabel[]
		})
	}

	/**
	 * Get project milestones
	 * Public method for UI utilities
	 */
	async getProjectMilestones(
		integration: Integration,
		projectId: string,
	): Promise<GitLabMilestone[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const baseUrl = this.getBaseUrl(integration)

			const response = await ssrfSafeFetch(
				`${baseUrl}/projects/${encodeURIComponent(projectId)}/milestones?state=active`,
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
						Accept: 'application/json',
					},
				},
			)

			if (!response.ok) {
				throw new Error(
					`Failed to get GitLab project milestones: ${response.statusText}`,
				)
			}

			return (await response.json()) as GitLabMilestone[]
		})
	}

	/**
	 * Search project users for assignee selection
	 * Public method for UI utilities
	 */
	async searchProjectUsers(
		integration: Integration,
		projectId: string,
		query: string,
	): Promise<GitLabUser[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const baseUrl = this.getBaseUrl(integration)

			const params = new URLSearchParams({
				search: query,
				per_page: '20',
			})

			const response = await ssrfSafeFetch(
				`${baseUrl}/projects/${encodeURIComponent(projectId)}/users?${params}`,
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
						Accept: 'application/json',
					},
				},
			)

			if (!response.ok) {
				throw new Error(
					`Failed to search GitLab project users: ${response.statusText}`,
				)
			}

			return (await response.json()) as GitLabUser[]
		})
	}

	/**
	 * Get instance URL from integration config
	 */
	private getInstanceUrl(integration: Integration): string | undefined {
		const config =
			typeof integration.config === 'string'
				? JSON.parse(integration.config)
				: (integration.config as any)
		return config?.instanceUrl
	}
}
