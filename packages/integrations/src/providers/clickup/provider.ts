/**
 * ClickUp integration provider implementation
 */

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
 * ClickUp API response interfaces
 */
interface ClickUpOAuthResponse {
	access_token: string
	token_type: string
	expires_in?: number
	scope?: string
	error?: string
	error_description?: string
}

interface ClickUpUser {
	id: number
	username: string
	email: string
	color: string
	profilePicture?: string
	initials: string
	week_start_day: number
	global_font_support: boolean
	timezone: string
}

interface ClickUpTeam {
	id: string
	name: string
	color: string
	avatar?: string
	members: Array<{
		user: ClickUpUser
		invited_by: ClickUpUser
	}>
}

interface ClickUpSpace {
	id: string
	name: string
	color?: string
	private: boolean
	avatar?: string
	admin_can_manage?: boolean
	statuses: Array<{
		id: string
		status: string
		type: string
		orderindex: number
		color: string
	}>
	multiple_assignees: boolean
	features: {
		due_dates: {
			enabled: boolean
			start_date: boolean
			remap_due_dates: boolean
			remap_closed_due_date: boolean
		}
		time_tracking: {
			enabled: boolean
		}
		tags: {
			enabled: boolean
		}
		time_estimates: {
			enabled: boolean
		}
		checklists: {
			enabled: boolean
		}
		custom_fields: {
			enabled: boolean
		}
		remap_dependencies: {
			enabled: boolean
		}
		dependency_warning: {
			enabled: boolean
		}
		portfolios: {
			enabled: boolean
		}
	}
}

interface ClickUpList {
	id: string
	name: string
	orderindex: number
	status?: {
		status: string
		color: string
		hide_label: boolean
	}
	priority?: {
		priority: string
		color: string
	}
	assignee?: ClickUpUser
	task_count?: number
	due_date?: string
	due_date_time?: boolean
	start_date?: string
	start_date_time?: boolean
	folder: {
		id: string
		name: string
		hidden: boolean
		access: boolean
	}
	space: {
		id: string
		name: string
		access: boolean
	}
	archived: boolean
	override_statuses: boolean
	statuses: Array<{
		id: string
		status: string
		orderindex: number
		color: string
		type: string
	}>
	permission_level: string
}

interface ClickUpCreateTaskResponse {
	id: string
	custom_id?: string
	name: string
	text_content?: string
	description?: string
	url: string
}

/**
 * ClickUp integration provider
 */
export class ClickUpProvider extends BaseIntegrationProvider {
	readonly name = 'clickup'
	readonly type = 'productivity' as const
	readonly displayName = 'ClickUp'
	readonly description =
		'Connect notes to ClickUp spaces and lists for task management and project tracking'
	readonly logoPath = '/icons/clickup.svg'

	private readonly apiBaseUrl = 'https://api.clickup.com/api/v2'
	private readonly authBaseUrl = 'https://app.clickup.com'
	private readonly tokenUrl = 'https://api.clickup.com/api/v2/oauth/token'

	constructor() {
		super()
	}

	private get clientId(): string {
		const clientId = ENV.CLICKUP_CLIENT_ID
		if (!clientId) {
			throw new Error('CLICKUP_CLIENT_ID environment variable is required')
		}
		return clientId
	}

	private get clientSecret(): string {
		const clientSecret = ENV.CLICKUP_CLIENT_SECRET
		if (!clientSecret) {
			throw new Error('CLICKUP_CLIENT_SECRET environment variable is required')
		}
		return clientSecret
	}

	/**
	 * Generate ClickUp OAuth authorization URL
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

		// ClickUp uses a non-standard OAuth implementation
		// Authorization URL: https://app.clickup.com/api
		// Parameters: client_id, redirect_uri, and optional state (NO response_type)
		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: redirectUri,
			state,
		})

		return `${this.authBaseUrl}/api?${params.toString()}`
	}

	/**
	 * Handle OAuth callback and exchange code for tokens
	 */
	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const { code, state, error, errorDescription } = params

		if (error) {
			throw new Error(`ClickUp OAuth error: ${errorDescription || error}`)
		}

		if (!code || !state) {
			throw new Error('Missing required OAuth parameters')
		}

		// Validate OAuth state
		this.parseOAuthState(state)

		try {
			const tokenResponse = await fetch(this.tokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: JSON.stringify({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					code,
					grant_type: 'authorization_code',
				}),
			})

			if (!tokenResponse.ok) {
				const errorText = await tokenResponse.text()
				throw new Error(`Token exchange failed: ${errorText}`)
			}

			const tokenData = (await tokenResponse.json()) as ClickUpOAuthResponse

			if (tokenData.error) {
				throw new Error(
					`Token exchange error: ${tokenData.error_description || tokenData.error}`,
				)
			}

			// Get user information to store in config
			const user = await this.getCurrentUser(tokenData.access_token)

			const expiresAt = tokenData.expires_in
				? new Date(Date.now() + tokenData.expires_in * 1000)
				: undefined

			return {
				accessToken: tokenData.access_token,
				expiresAt,
				scope: tokenData.scope,
				metadata: {
					user: {
						id: user.id,
						username: user.username,
						email: user.email,
						profilePicture: user.profilePicture,
						initials: user.initials,
						timezone: user.timezone,
					},
				},
			}
		} catch (error) {
			console.error('ClickUp OAuth callback error:', error)
			throw new Error(
				`Failed to exchange ClickUp authorization code: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Refresh ClickUp access token
	 * Note: ClickUp doesn't currently support refresh tokens, so this will throw an error
	 */
	async refreshToken(_refreshToken: string): Promise<TokenData> {
		// ClickUp doesn't currently support refresh tokens
		// Users will need to re-authenticate when tokens expire
		throw new Error(
			'ClickUp does not support token refresh. Please re-authenticate.',
		)
	}

	/**
	 * Get available ClickUp spaces and lists (mapped as channels for consistency)
	 */
	async getAvailableChannels(integration: Integration): Promise<Channel[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			const channels: Channel[] = []

			// Get user's teams
			const teams = await this.getTeams(accessToken)

			for (const team of teams) {
				// Get spaces for each team
				const spaces = await this.getSpaces(accessToken, team.id)

				for (const space of spaces) {
					// Add space as a channel
					channels.push({
						id: `space:${space.id}`,
						name: `${space.name} (Space)`,
						type: space.private ? 'private' : 'public',
						metadata: {
							type: 'space',
							spaceId: space.id,
							teamId: team.id,
							teamName: team.name,
							color: space.color,
							private: space.private,
						},
					})

					// Get lists for each space
					try {
						const lists = await this.getLists(accessToken, space.id)

						for (const list of lists) {
							channels.push({
								id: `list:${list.id}`,
								name: `${list.name} (List) - ${space.name}`,
								type: 'public',
								metadata: {
									type: 'list',
									listId: list.id,
									listName: list.name,
									spaceId: space.id,
									spaceName: space.name,
									teamId: team.id,
									teamName: team.name,
									taskCount: list.task_count,
									archived: list.archived,
								},
							})
						}
					} catch (error) {
						console.warn(`Failed to get lists for space ${space.name}:`, error)
						// Continue with other spaces even if one fails
					}
				}
			}

			return channels.sort((a, b) => a.name.localeCompare(b.name))
		})
	}

	/**
	 * Post a message to ClickUp (create a task)
	 */
	async postMessage(
		connection: NoteIntegrationConnection & { integration: Integration },
		message: MessageData,
	): Promise<void> {
		return this.makeAuthenticatedApiCall(
			connection.integration,
			async (accessToken) => {
				// Parse channel ID to determine if it's a space or list
				const channelId = connection.externalId
				let listId: string

				if (channelId.startsWith('list:')) {
					listId = channelId.replace('list:', '')
				} else if (channelId.startsWith('space:')) {
					// If it's a space, we need to create the task in a default list
					// For now, we'll throw an error and require list selection
					throw new Error(
						'Please select a specific list within the space to create tasks',
					)
				} else {
					throw new Error('Invalid channel configuration')
				}

				// Format task data
				const taskData = await this.formatClickUpTask(
					message,
					listId,
					connection.integration,
					connection,
				)

				// Create the task
				const task = await this.createTask(accessToken, listId, taskData)

				console.log(
					`Successfully created ClickUp task: ${task.name} (${task.url})`,
				)
			},
		)
	}

	/**
	 * Validate a ClickUp connection
	 */
	async validateConnection(
		connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		try {
			return await this.makeAuthenticatedApiCall(
				connection.integration,
				async (accessToken) => {
					// Try to get user information to validate the token
					await this.getCurrentUser(accessToken)

					// If channel is a list, try to get the list to ensure it still exists
					if (connection.externalId.startsWith('list:')) {
						const listId = connection.externalId.replace('list:', '')
						await this.getList(accessToken, listId)
					}

					return true
				},
			)
		} catch (error) {
			console.error('ClickUp connection validation failed:', error)
			return false
		}
	}

	/**
	 * Get ClickUp provider configuration schema
	 */
	getConfigSchema(): Record<string, any> {
		return {
			user: {
				type: 'object',
				title: 'User Information',
				description: 'Connected ClickUp user details',
				properties: {
					id: { type: 'number', title: 'User ID' },
					username: { type: 'string', title: 'Username' },
					email: { type: 'string', title: 'Email' },
					profilePicture: { type: 'string', title: 'Profile Picture URL' },
					initials: { type: 'string', title: 'Initials' },
					timezone: { type: 'string', title: 'Timezone' },
				},
			},
		}
	}

	/**
	 * Get current user information
	 */
	private async getCurrentUser(accessToken: string): Promise<ClickUpUser> {
		const response = await fetch(`${this.apiBaseUrl}/user`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
			},
		})

		if (!response.ok) {
			throw new Error(`Failed to get ClickUp user: ${response.statusText}`)
		}

		const data = (await response.json()) as { user: any }
		return data.user
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
				throw new Error('No access token available for ClickUp integration')
			}

			// Decrypt the access token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(integration.accessToken)
			return await apiCall(accessToken)
		} catch (error) {
			// ClickUp doesn't support refresh tokens, so we can't automatically refresh
			// The user will need to re-authenticate
			if (error instanceof Error && error.message.includes('401')) {
				throw new Error('ClickUp token has expired. Please re-authenticate.')
			}
			throw error
		}
	}

	/**
	 * Get user's teams
	 */
	private async getTeams(accessToken: string): Promise<ClickUpTeam[]> {
		const response = await fetch(`${this.apiBaseUrl}/team`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
			},
		})

		if (!response.ok) {
			throw new Error(`Failed to get ClickUp teams: ${response.statusText}`)
		}

		const data = (await response.json()) as { teams: any[] }
		return data.teams
	}

	/**
	 * Get spaces for a team
	 */
	private async getSpaces(
		accessToken: string,
		teamId: string,
	): Promise<ClickUpSpace[]> {
		const response = await fetch(
			`${this.apiBaseUrl}/team/${teamId}/space?archived=false`,
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
			},
		)

		if (!response.ok) {
			throw new Error(`Failed to get ClickUp spaces: ${response.statusText}`)
		}

		const data = (await response.json()) as { spaces: any[] }
		return data.spaces
	}

	/**
	 * Get lists for a space
	 */
	private async getLists(
		accessToken: string,
		spaceId: string,
	): Promise<ClickUpList[]> {
		const response = await fetch(
			`${this.apiBaseUrl}/space/${spaceId}/list?archived=false`,
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
			},
		)

		if (!response.ok) {
			throw new Error(`Failed to get ClickUp lists: ${response.statusText}`)
		}

		const data = (await response.json()) as { lists: any[] }
		return data.lists
	}

	/**
	 * Get a specific list
	 */
	private async getList(
		accessToken: string,
		listId: string,
	): Promise<ClickUpList> {
		const response = await fetch(`${this.apiBaseUrl}/list/${listId}`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
			},
		})

		if (!response.ok) {
			throw new Error(`Failed to get ClickUp list: ${response.statusText}`)
		}

		return response.json() as Promise<ClickUpList>
	}

	/**
	 * Create a ClickUp task
	 */
	private async createTask(
		accessToken: string,
		listId: string,
		taskData: any,
	): Promise<ClickUpCreateTaskResponse> {
		const response = await fetch(`${this.apiBaseUrl}/list/${listId}/task`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify(taskData),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Failed to create ClickUp task: ${errorText}`)
		}

		return response.json() as Promise<ClickUpCreateTaskResponse>
	}

	/**
	 * Format message data as ClickUp task
	 */
	private async formatClickUpTask(
		message: MessageData,
		listId: string,
		integration: Integration,
		connection?: NoteIntegrationConnection,
	): Promise<any> {
		const connectionConfig = connection?.config
			? typeof connection.config === 'string'
				? JSON.parse(connection.config)
				: connection.config
			: ({} as any)

		// Format task title
		const title = this.formatTaskTitle(message)

		// Format task description
		const description = this.formatTaskDescription(message, connectionConfig)

		// Base task data
		const taskData: any = {
			name: title,
			description: description,
			markdown_description: description,
		}

		// Add optional fields based on connection configuration
		if (connectionConfig.includeNoteContent !== false) {
			// Include the full note content in the description by default
		}

		if (connectionConfig.defaultPriority) {
			taskData.priority = connectionConfig.defaultPriority
		}

		if (
			connectionConfig.defaultAssignees &&
			connectionConfig.defaultAssignees.length > 0
		) {
			taskData.assignees = connectionConfig.defaultAssignees
		}

		if (
			connectionConfig.defaultTags &&
			connectionConfig.defaultTags.length > 0
		) {
			taskData.tags = connectionConfig.defaultTags
		}

		if (connectionConfig.defaultStatus) {
			taskData.status = connectionConfig.defaultStatus
		}

		return taskData
	}

	/**
	 * Format task title from message data
	 */
	protected formatTaskTitle(message: MessageData): string {
		const emoji = this.getChangeEmoji(message.changeType)
		const truncatedTitle = this.truncateText(message.title, 100)
		return `${emoji} ${truncatedTitle}`
	}

	/**
	 * Format task description from message data
	 */
	private formatTaskDescription(message: MessageData, config: any): string {
		const parts: string[] = []

		// Add change type information
		const changeTypeText =
			message.changeType === 'created'
				? 'Created'
				: message.changeType === 'updated'
					? 'Updated'
					: 'Deleted'
		parts.push(`**${changeTypeText} by ${message.author}**`)

		// Add note URL
		if (message.noteUrl) {
			parts.push(`[View Note](${message.noteUrl})`)
		}

		// Add note content if enabled
		if (config.includeNoteContent !== false && message.content) {
			parts.push('---')
			parts.push('**Note Content:**')
			parts.push(message.content)
		}

		return parts.join('\n\n')
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
			default:
				return '📄'
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

	/**
	 * Get current user details from ClickUp
	 * Public method for UI utilities
	 */
	async getCurrentUserDetails(integration: Integration): Promise<ClickUpUser> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			return this.getCurrentUser(accessToken)
		})
	}

	/**
	 * Get team spaces for UI utilities
	 */
	async getTeamSpaces(
		integration: Integration,
		teamId: string,
	): Promise<ClickUpSpace[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			return this.getSpaces(accessToken, teamId)
		})
	}

	/**
	 * Get space lists for UI utilities
	 */
	async getSpaceLists(
		integration: Integration,
		spaceId: string,
	): Promise<ClickUpList[]> {
		return this.makeAuthenticatedApiCall(integration, async (accessToken) => {
			return this.getLists(accessToken, spaceId)
		})
	}
}
