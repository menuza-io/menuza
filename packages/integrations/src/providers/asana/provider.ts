/**
 * Asana integration provider implementation
 */

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
 * Asana API response interfaces
 */
interface AsanaOAuthResponse {
	access_token: string
	refresh_token?: string
	expires_in?: number
	token_type: string
	data?: {
		id: string
		gid: string
		name: string
		email?: string
	}
	error?: string
	error_description?: string
}

interface AsanaUser {
	gid: string
	name: string
	email?: string
	photo?: {
		image_21x21?: string
		image_27x27?: string
		image_36x36?: string
		image_60x60?: string
	}
	workspaces?: AsanaWorkspace[]
}

interface AsanaWorkspace {
	gid: string
	name: string
	resource_type: string
}

interface AsanaProject {
	gid: string
	name: string
	resource_type: string
	archived: boolean
	color?: string
	notes?: string
	public: boolean
	workspace: {
		gid: string
		name: string
		resource_type: string
	}
	team?: {
		gid: string
		name: string
		resource_type: string
	}
}

interface AsanaProjectsResponse {
	data: AsanaProject[]
}

interface AsanaTask {
	gid: string
	name: string
	resource_type: string
	permalink_url: string
}

interface AsanaCreateTaskResponse {
	data: AsanaTask
}

interface AsanaErrorResponse {
	errors: Array<{
		message: string
		phrase: string
		help?: string
	}>
}

/**
 * Asana integration provider
 */
export class AsanaProvider extends BaseIntegrationProvider {
	readonly name = 'asana'
	readonly type = 'productivity' as const
	readonly displayName = 'Asana'
	readonly description =
		'Connect notes to Asana projects for task management and team collaboration'
	readonly logoPath = '/icons/asana.svg'

	constructor() {
		super()
	}

	private get clientId(): string {
		const clientId = ENV.ASANA_CLIENT_ID
		if (!clientId) {
			throw new Error('ASANA_CLIENT_ID environment variable is required')
		}
		return clientId
	}

	private get clientSecret(): string {
		const clientSecret = ENV.ASANA_CLIENT_SECRET
		if (!clientSecret) {
			throw new Error('ASANA_CLIENT_SECRET environment variable is required')
		}
		return clientSecret
	}

	/**
	 * Generate Asana OAuth authorization URL
	 */
	async getAuthUrl(
		organizationId: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<string> {
		// Create state with organization and provider info
		const state = this.generateOAuthState(organizationId, {
			redirectUri,
			...additionalParams,
		})

		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			state,
			// Asana doesn't use scopes - access is determined by workspace permissions
		})

		const authUrl = `https://app.asana.com/-/oauth_authorize?${params.toString()}`
		return authUrl
	}

	/**
	 * Handle OAuth callback and exchange code for tokens
	 */
	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const { code, state, error, errorDescription } = params

		if (error) {
			throw new Error(
				`Asana OAuth error: ${error} - ${errorDescription || 'Unknown error'}`,
			)
		}

		if (!code) {
			throw new Error('No authorization code received from Asana')
		}

		// Parse and validate state
		const stateData = this.parseOAuthState(state)

		try {
			// Exchange authorization code for access token
			const response = await fetch('https://app.asana.com/-/oauth_token', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: this.clientId,
					client_secret: this.clientSecret,
					code,
					redirect_uri: stateData.redirectUri || '',
				}),
			})

			if (!response.ok) {
				const errorText = await response.text()
				console.error(
					'Asana OAuth token exchange failed:',
					response.status,
					errorText,
				)
				throw new Error(
					`Asana OAuth token exchange failed: ${response.status} ${response.statusText}`,
				)
			}

			const tokenData = (await response.json()) as AsanaOAuthResponse

			if (tokenData.error) {
				throw new Error(
					`Asana OAuth error: ${tokenData.error} - ${tokenData.error_description || 'Unknown error'}`,
				)
			}

			if (!tokenData.access_token) {
				throw new Error('No access token received from Asana')
			}

			// Get user information and workspaces
			const userInfo = await this.getCurrentUser(tokenData.access_token)
			const workspaces = await this.getUserWorkspaces(tokenData.access_token)

			let expiresAt: Date | undefined
			if (tokenData.expires_in) {
				expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)
			}

			return {
				accessToken: tokenData.access_token,
				refreshToken: tokenData.refresh_token,
				expiresAt,
				metadata: {
					user: userInfo,
					workspaces,
				},
			}
		} catch (error) {
			console.error('Error exchanging OAuth code for Asana token:', error)
			throw new Error(
				`Failed to exchange OAuth code: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Refresh Asana access token
	 */
	async refreshToken(refreshToken: string): Promise<TokenData> {
		try {
			const response = await fetch('https://app.asana.com/-/oauth_token', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					client_id: this.clientId,
					client_secret: this.clientSecret,
					refresh_token: refreshToken,
				}),
			})

			if (!response.ok) {
				const errorText = await response.text()
				console.error('Asana token refresh failed:', response.status, errorText)
				throw new Error(
					`Asana token refresh failed: ${response.status} ${response.statusText}`,
				)
			}

			const tokenData = (await response.json()) as AsanaOAuthResponse

			if (tokenData.error) {
				throw new Error(
					`Asana token refresh error: ${tokenData.error} - ${tokenData.error_description || 'Unknown error'}`,
				)
			}

			if (!tokenData.access_token) {
				throw new Error('No access token received from Asana refresh')
			}

			let expiresAt: Date | undefined
			if (tokenData.expires_in) {
				expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)
			}

			return {
				accessToken: tokenData.access_token,
				refreshToken: tokenData.refresh_token || refreshToken,
				expiresAt,
			}
		} catch (error) {
			throw new Error(
				`Failed to refresh token: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Get available Asana projects (mapped as channels)
	 */
	async getAvailableChannels(integration: Integration): Promise<Channel[]> {
		try {
			if (!integration.accessToken) {
				throw new Error('No access token available for Asana integration')
			}

			// Decrypt the access token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(integration.accessToken)

			if (!accessToken) {
				throw new Error('Failed to decrypt access token for Asana integration')
			}

			// Get user's workspaces first
			const workspaces = await this.getUserWorkspaces(accessToken)
			const channels: Channel[] = []

			// Get projects from all accessible workspaces
			for (const workspace of workspaces) {
				try {
					const projects = await this.getWorkspaceProjects(
						accessToken,
						workspace.gid,
					)

					// Convert projects to channels
					for (const project of projects) {
						if (!project.archived) {
							// Only include active projects
							channels.push({
								id: project.gid,
								name: `${project.name} (${workspace.name})`,
								type: project.public ? 'public' : 'private',
								metadata: {
									projectName: project.name,
									workspaceName: workspace.name,
									workspaceGid: workspace.gid,
									color: project.color,
									notes: project.notes,
									team: project.team,
								},
							})
						}
					}
				} catch (error) {
					console.warn(
						`Failed to fetch projects for workspace ${workspace.name}:`,
						error,
					)
					// Continue with other workspaces
				}
			}

			return channels.sort((a, b) => a.name.localeCompare(b.name))
		} catch (error) {
			throw new Error(
				`Failed to fetch Asana projects: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Post a message to Asana by creating a task
	 */
	async postMessage(
		connection: NoteIntegrationConnection & { integration: Integration },
		message: MessageData,
	): Promise<void> {
		try {
			// Decrypt the access token
			const { decryptToken } = await import('../../encryption')

			if (!connection.integration.accessToken) {
				throw new Error('No access token available for Asana integration')
			}

			const accessToken = await decryptToken(connection.integration.accessToken)

			if (!accessToken) {
				throw new Error('Failed to decrypt access token for Asana integration')
			}

			// Parse connection config
			const config = connection.config as any
			const projectGid = config.projectGid || connection.externalId
			const includeNoteContent = config.includeNoteContent ?? true

			// Prepare task data
			const taskName = message.title
			let taskNotes = `Created from note by ${message.author}`

			if (includeNoteContent && message.content) {
				taskNotes += `\n\n${message.content}`
			}

			if (message.noteUrl) {
				taskNotes += `\n\nSource: ${message.noteUrl}`
			}

			// Create task data
			const taskData: any = {
				name: taskName,
				notes: taskNotes,
				projects: [projectGid],
			}

			// Add default assignee if configured
			if (config.defaultAssignee) {
				taskData.assignee = config.defaultAssignee
			}

			// Add to default section if configured
			if (config.defaultSection) {
				taskData.memberships = [
					{
						project: projectGid,
						section: config.defaultSection,
					},
				]
			}

			// Create the task
			const response = await fetch('https://app.asana.com/api/1.0/tasks', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					data: taskData,
				}),
			})

			if (!response.ok) {
				const errorText = await response.text()
				let errorMessage = `Asana API error: ${response.status} ${response.statusText}`

				try {
					const errorData = JSON.parse(errorText) as AsanaErrorResponse
					if (errorData.errors && errorData.errors.length > 0) {
						errorMessage += ` - ${errorData.errors[0]?.message || 'Unknown error'}`
					}
				} catch {
					// If we can't parse the error, use the raw text
					errorMessage += ` - ${errorText}`
				}

				console.error('Asana task creation failed:', errorMessage)
				throw new Error(errorMessage)
			}

			const _result = (await response.json()) as AsanaCreateTaskResponse
		} catch (error) {
			throw new Error(
				`Failed to create Asana task: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Validate Asana connection
	 */
	async validateConnection(
		connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		try {
			// Decrypt the access token
			const { decryptToken } = await import('../../encryption')

			if (!connection.integration.accessToken) {
				return false
			}

			const accessToken = await decryptToken(connection.integration.accessToken)

			if (!accessToken) {
				return false
			}

			// Parse connection config
			const config = connection.config as any
			const projectGid = config.projectGid || connection.externalId

			// Try to fetch the specific project to validate access
			const response = await fetch(
				`https://app.asana.com/api/1.0/projects/${projectGid}`,
				{
					method: 'GET',
					headers: {
						Authorization: `Bearer ${accessToken}`,
					},
				},
			)

			if (!response.ok) {
				console.warn(
					`Asana project validation failed: ${response.status} ${response.statusText}`,
				)
				return false
			}

			const _project = await response.json()
			return true
		} catch {
			return false
		}
	}

	/**
	 * Get provider configuration schema
	 */
	getConfigSchema(): Record<string, any> {
		return {
			type: 'object',
			properties: {
				user: {
					type: 'object',
					properties: {
						gid: { type: 'string' },
						name: { type: 'string' },
						email: { type: 'string' },
						photo: {
							type: 'object',
							properties: {
								image_21x21: { type: 'string' },
								image_27x27: { type: 'string' },
								image_36x36: { type: 'string' },
								image_60x60: { type: 'string' },
							},
						},
					},
					required: ['gid', 'name'],
				},
				workspaces: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							gid: { type: 'string' },
							name: { type: 'string' },
							resource_type: { type: 'string' },
						},
						required: ['gid', 'name', 'resource_type'],
					},
				},
			},
			required: ['user', 'workspaces'],
		}
	}

	/**
	 * Helper method to get current user information
	 */
	private async getCurrentUser(accessToken: string): Promise<AsanaUser> {
		const response = await fetch('https://app.asana.com/api/1.0/users/me', {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		})

		if (!response.ok) {
			throw new Error(
				`Failed to fetch Asana user info: ${response.status} ${response.statusText}`,
			)
		}

		const result = (await response.json()) as { data: AsanaUser }
		return result.data
	}

	/**
	 * Helper method to get user's workspaces
	 */
	private async getUserWorkspaces(
		accessToken: string,
	): Promise<AsanaWorkspace[]> {
		const response = await fetch('https://app.asana.com/api/1.0/workspaces', {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		})

		if (!response.ok) {
			throw new Error(
				`Failed to fetch Asana workspaces: ${response.status} ${response.statusText}`,
			)
		}

		const result = (await response.json()) as { data: AsanaWorkspace[] }
		return result.data
	}

	/**
	 * Helper method to get projects in a workspace
	 */
	private async getWorkspaceProjects(
		accessToken: string,
		workspaceGid: string,
	): Promise<AsanaProject[]> {
		const response = await fetch(
			`https://app.asana.com/api/1.0/projects?workspace=${workspaceGid}&archived=false&limit=100`,
			{
				method: 'GET',
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			},
		)

		if (!response.ok) {
			throw new Error(
				`Failed to fetch Asana projects for workspace ${workspaceGid}: ${response.status} ${response.statusText}`,
			)
		}

		const result = (await response.json()) as AsanaProjectsResponse
		return result.data
	}
}
