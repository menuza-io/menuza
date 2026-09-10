/**
 * GitHub integration provider implementation
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
 * GitHub API response interfaces
 */
interface GitHubOAuthResponse {
	access_token: string
	refresh_token?: string
	expires_in?: number
	scope?: string
	token_type: string
	error?: string
	error_description?: string
}

interface GitHubRepository {
	id: number
	name: string
	full_name: string
	description?: string
	private: boolean
	html_url: string
	clone_url: string
	ssh_url: string
	default_branch: string
	owner: {
		id: number
		login: string
		avatar_url: string
		type: 'User' | 'Organization'
	}
	permissions: {
		admin: boolean
		maintain?: boolean
		push: boolean
		triage?: boolean
		pull: boolean
	}
	archived: boolean
	disabled: boolean
	fork: boolean
}

interface GitHubUser {
	id: number
	login: string
	name?: string
	email?: string
	avatar_url: string
	html_url: string
	type: 'User' | 'Organization'
	company?: string
	location?: string
	bio?: string
}

interface GitHubCreateIssueResponse {
	id: number
	number: number
	title: string
	body?: string
	html_url: string
	state: 'open' | 'closed'
	user: GitHubUser
	repository_url: string
}

interface GitHubLabel {
	id: number
	name: string
	color: string
	description?: string
	default: boolean
}

interface GitHubMilestone {
	id: number
	number: number
	title: string
	description?: string
	state: 'open' | 'closed'
	html_url: string
	due_on?: string
	created_at: string
	updated_at: string
}

/**
 * GitHub integration provider
 */
export class GitHubProvider extends BaseIntegrationProvider {
	readonly name = 'github'
	readonly type = 'productivity' as const
	readonly displayName = 'GitHub'
	readonly description =
		'Connect notes to GitHub repositories for issue tracking and project management'
	readonly logoPath = '/icons/github.svg'

	private readonly apiBaseUrl = 'https://api.github.com'
	private readonly authBaseUrl = 'https://github.com/login/oauth'

	constructor() {
		super()
	}

	private clientId(): string {
		const clientId = ENV.GITHUB_INTEGRATION_CLIENT_ID
		if (!clientId) {
			throw new Error(
				'GITHUB_INTEGRATION_CLIENT_ID environment variable is required',
			)
		}
		return clientId
	}

	private clientSecret(): string {
		const clientSecret = ENV.GITHUB_INTEGRATION_CLIENT_SECRET
		if (!clientSecret) {
			throw new Error(
				'GITHUB_INTEGRATION_CLIENT_SECRET environment variable is required',
			)
		}
		return clientSecret
	}

	/**
	 * Generate GitHub OAuth authorization URL
	 */
	async getAuthUrl(
		organizationId: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<string> {
		const state = this.generateOAuthState(organizationId, additionalParams)

		const params = new URLSearchParams({
			client_id: this.clientId(),
			redirect_uri: redirectUri,
			scope: 'repo read:user user:email',
			state,
			response_type: 'code',
		})

		return `${this.authBaseUrl}/authorize?${params.toString()}`
	}

	/**
	 * Handle OAuth callback and exchange code for tokens
	 */
	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		if (params.error) {
			throw new Error(
				`GitHub OAuth error: ${params.error} - ${params.errorDescription || 'Unknown error'}`,
			)
		}

		if (!params.code) {
			throw new Error('Authorization code is required')
		}

		// Validate state
		this.parseOAuthState(params.state)

		// Exchange code for access token
		const tokenResponse = await fetch(`${this.authBaseUrl}/access_token`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				client_id: this.clientId(),
				client_secret: this.clientSecret(),
				code: params.code,
			}).toString(),
		})

		if (!tokenResponse.ok) {
			const errorText = await tokenResponse.text()
			throw new Error(
				`Failed to exchange code for token: ${tokenResponse.statusText} - ${errorText}`,
			)
		}

		const tokenData = (await tokenResponse.json()) as GitHubOAuthResponse

		if (tokenData.error) {
			throw new Error(
				`GitHub token error: ${tokenData.error} - ${tokenData.error_description || 'Unknown error'}`,
			)
		}

		return {
			accessToken: tokenData.access_token,
			refreshToken: tokenData.refresh_token,
			expiresAt: tokenData.expires_in
				? new Date(Date.now() + tokenData.expires_in * 1000)
				: undefined,
			scope: tokenData.scope,
		}
	}

	/**
	 * Refresh GitHub access token
	 * Note: GitHub doesn't support refresh tokens in the standard OAuth flow
	 */
	async refreshToken(_refreshToken: string): Promise<TokenData> {
		// GitHub doesn't support refresh tokens in their OAuth flow
		// Users need to re-authenticate when tokens expire
		throw new Error(
			'GitHub does not support token refresh. Please re-authenticate.',
		)
	}

	/**
	 * Get available GitHub repositories (mapped as channels for consistency)
	 */
	async getAvailableChannels(integration: Integration): Promise<Channel[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const repositories = await this.getRepositories(accessToken)

			return repositories
				.filter(
					(repo) => !repo.archived && !repo.disabled && repo.permissions?.push,
				) // Only repos where user can create issues
				.map((repo) => ({
					id: repo.id.toString(),
					name: `${repo.owner.login}/${repo.name}`,
					type: repo.private ? 'private' : 'public',
					metadata: {
						repositoryId: repo.id.toString(),
						repositoryName: repo.name,
						repositoryFullName: repo.full_name,
						ownerName: repo.owner.login,
						description: repo.description,
						htmlUrl: repo.html_url,
						defaultBranch: repo.default_branch,
						isPrivate: repo.private,
						isFork: repo.fork,
					},
				})) as Channel[]
		})
	}

	/**
	 * Post a message to GitHub (create an issue)
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

				// Use repositoryFullName from config (either direct or from channelMetadata), or fall back to externalId
				const repositoryFullName =
					config?.repositoryFullName ||
					config?.channelMetadata?.repositoryFullName ||
					connection.externalId

				if (!repositoryFullName) {
					throw new Error(
						'Repository full name is required for GitHub integration',
					)
				}

				const issueData = await this.formatGitHubIssue(message, connection)
				await this.createIssue(accessToken, repositoryFullName, issueData)
			},
		)
	}

	/**
	 * Validate a GitHub connection
	 */
	async validateConnection(
		connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		try {
			const config =
				typeof connection.config === 'string'
					? JSON.parse(connection.config)
					: (connection.config as any)

			const repositoryFullName = config?.repositoryFullName

			if (!repositoryFullName) {
				return false
			}

			return await this.makeAuthenticatedApiCall(
				connection.integration,
				async (accessToken) => {
					const repository = await this.getRepository(
						accessToken,
						repositoryFullName,
					)
					return repository !== null && repository.permissions.push === true
				},
			)
		} catch (error) {
			console.error('GitHub connection validation failed:', error)
			return false
		}
	}

	/**
	 * Get GitHub provider configuration schema
	 */
	getConfigSchema(): Record<string, any> {
		return {
			type: 'object',
			properties: {
				user: {
					type: 'object',
					properties: {
						id: { type: 'number' },
						login: { type: 'string' },
						name: { type: 'string' },
						email: { type: 'string' },
						avatarUrl: { type: 'string' },
					},
					required: ['id', 'login'],
				},
				scope: { type: 'string' },
			},
			required: ['user', 'scope'],
		}
	}

	/**
	 * Get current user information
	 */
	async getCurrentUser(accessToken: string): Promise<GitHubUser> {
		const response = await fetch(`${this.apiBaseUrl}/user`, {
			headers: {
				Authorization: `token ${accessToken}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': USER_AGENT,
			},
		})

		if (!response.ok) {
			throw new Error(`Failed to get GitHub user: ${response.statusText}`)
		}

		return (await response.json()) as GitHubUser
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
				throw new Error('No access token available for GitHub integration')
			}
			// Decrypt the access token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(integration.accessToken)
			return await apiCall(accessToken)
		} catch (error: any) {
			// GitHub doesn't support token refresh, so we can't retry with a new token
			if (
				error.message?.includes('401') ||
				error.message?.includes('Unauthorized')
			) {
				throw new Error('GitHub token has expired. Please re-authenticate.')
			}
			throw error
		}
	}

	/**
	 * Get GitHub repositories
	 */
	async getRepositories(accessToken: string): Promise<GitHubRepository[]> {
		const allRepositories: GitHubRepository[] = []
		let page = 1
		const perPage = 100

		while (true) {
			const response = await fetch(
				`${this.apiBaseUrl}/user/repos?page=${page}&per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`,
				{
					headers: {
						Authorization: `token ${accessToken}`,
						Accept: 'application/vnd.github+json',
						'X-GitHub-Api-Version': '2022-11-28',
						'User-Agent': USER_AGENT,
					},
				},
			)

			if (!response.ok) {
				const errorText = await response.text()
				throw new Error(
					`Failed to get GitHub repositories: ${response.status} ${response.statusText} - ${errorText}`,
				)
			}

			const repositories = (await response.json()) as GitHubRepository[]

			if (repositories.length === 0) {
				break
			}

			allRepositories.push(...repositories)

			if (repositories.length < perPage) {
				break
			}

			page++
		}

		return allRepositories
	}

	/**
	 * Get a specific GitHub repository
	 */
	async getRepository(
		accessToken: string,
		repositoryFullName: string,
	): Promise<GitHubRepository> {
		const response = await fetch(
			`${this.apiBaseUrl}/repos/${repositoryFullName}`,
			{
				headers: {
					Authorization: `token ${accessToken}`,
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
					'User-Agent': USER_AGENT,
				},
			},
		)

		if (!response.ok) {
			throw new Error(`Failed to get GitHub repository: ${response.statusText}`)
		}

		return (await response.json()) as GitHubRepository
	}

	/**
	 * Create a GitHub issue
	 */
	async createIssue(
		accessToken: string,
		repositoryFullName: string,
		issueData: any,
	): Promise<GitHubCreateIssueResponse> {
		const response = await fetch(
			`${this.apiBaseUrl}/repos/${repositoryFullName}/issues`,
			{
				method: 'POST',
				headers: {
					Authorization: `token ${accessToken}`,
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
					'Content-Type': 'application/json',
					'User-Agent': USER_AGENT,
				},
				body: JSON.stringify(issueData),
			},
		)

		if (!response.ok) {
			const errorData = await response.json().catch(() => ({}))
			throw new Error(
				`Failed to create GitHub issue: ${response.statusText} - ${JSON.stringify(errorData)}`,
			)
		}

		return (await response.json()) as GitHubCreateIssueResponse
	}

	/**
	 * Format message data as GitHub issue
	 */
	async formatGitHubIssue(
		message: MessageData,
		connection: NoteIntegrationConnection,
	): Promise<any> {
		const config =
			typeof connection.config === 'string'
				? JSON.parse(connection.config)
				: (connection.config as any)

		const includeContent = config?.includeNoteContent ?? true

		let body = `**Author:** ${message.author}\n\n`

		if (includeContent && message.content) {
			body += `**Content:**\n${message.content}\n\n`
		}

		body += `**Source:** [View Note](${message.noteUrl})\n`
		body += `**Change Type:** ${message.changeType}\n`
		body += `**Created:** ${new Date().toISOString()}`

		const issueData: any = {
			title: this.truncateText(message.title, 256),
			body: body,
		}

		// Add labels if configured
		if (config?.defaultLabels && config.defaultLabels.length > 0) {
			issueData.labels = config.defaultLabels
		}

		// Add assignees if configured
		if (config?.defaultAssignees && config.defaultAssignees.length > 0) {
			issueData.assignees = config.defaultAssignees
		}

		// Add milestone if configured
		if (config?.defaultMilestone) {
			issueData.milestone = config.defaultMilestone
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

	// Public methods for UI utilities

	/**
	 * Get current user details from GitHub
	 */
	async getCurrentUserDetails(integration: Integration): Promise<GitHubUser> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			return await this.getCurrentUser(accessToken)
		})
	}

	/**
	 * Get repository labels
	 */
	async getRepositoryLabels(
		integration: Integration,
		repositoryFullName: string,
	): Promise<GitHubLabel[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const response = await fetch(
				`${this.apiBaseUrl}/repos/${repositoryFullName}/labels`,
				{
					headers: {
						Authorization: `token ${accessToken}`,
						Accept: 'application/vnd.github+json',
						'X-GitHub-Api-Version': '2022-11-28',
						'User-Agent': USER_AGENT,
					},
				},
			)

			if (!response.ok) {
				throw new Error(
					`Failed to get repository labels: ${response.statusText}`,
				)
			}

			return (await response.json()) as GitHubLabel[]
		})
	}

	/**
	 * Get repository milestones
	 */
	async getRepositoryMilestones(
		integration: Integration,
		repositoryFullName: string,
	): Promise<GitHubMilestone[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const response = await fetch(
				`${this.apiBaseUrl}/repos/${repositoryFullName}/milestones?state=open`,
				{
					headers: {
						Authorization: `token ${accessToken}`,
						Accept: 'application/vnd.github+json',
						'X-GitHub-Api-Version': '2022-11-28',
						'User-Agent': USER_AGENT,
					},
				},
			)

			if (!response.ok) {
				throw new Error(
					`Failed to get repository milestones: ${response.statusText}`,
				)
			}

			return (await response.json()) as GitHubMilestone[]
		})
	}

	/**
	 * Search repository collaborators for assignee selection
	 */
	async searchRepositoryCollaborators(
		integration: Integration,
		repositoryFullName: string,
		query: string,
	): Promise<GitHubUser[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const response = await fetch(
				`${this.apiBaseUrl}/repos/${repositoryFullName}/collaborators`,
				{
					headers: {
						Authorization: `token ${accessToken}`,
						Accept: 'application/vnd.github+json',
						'X-GitHub-Api-Version': '2022-11-28',
						'User-Agent': USER_AGENT,
					},
				},
			)

			if (!response.ok) {
				throw new Error(
					`Failed to get repository collaborators: ${response.statusText}`,
				)
			}

			const collaborators = (await response.json()) as GitHubUser[]

			// Filter collaborators by query if provided
			if (query) {
				const lowerQuery = query.toLowerCase()
				return collaborators.filter(
					(user) =>
						user.login.toLowerCase().includes(lowerQuery) ||
						(user.name && user.name.toLowerCase().includes(lowerQuery)),
				)
			}

			return collaborators
		})
	}
}
