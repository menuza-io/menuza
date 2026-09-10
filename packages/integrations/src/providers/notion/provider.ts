/**
 * Notion integration provider implementation
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
 * Notion API response interfaces
 */
interface NotionOAuthResponse {
	access_token: string
	token_type: string
	bot_id: string
	workspace_name: string
	workspace_icon: string
	workspace_id: string
	owner: {
		type: string
		user?: {
			object: string
			id: string
			name: string
			avatar_url?: string
			type: string
			person?: {
				email: string
			}
		}
	}
	duplicated_template_id?: string
	request_id: string
	error?: string
	error_description?: string
}

interface NotionDatabase {
	object: string
	id: string
	created_time: string
	created_by: {
		object: string
		id: string
	}
	last_edited_time: string
	last_edited_by: {
		object: string
		id: string
	}
	title: Array<{
		type: string
		text: {
			content: string
			link?: any
		}
		annotations: {
			bold: boolean
			italic: boolean
			strikethrough: boolean
			underline: boolean
			code: boolean
			color: string
		}
		plain_text: string
		href?: string
	}>
	description: Array<any>
	icon?: {
		type: string
		emoji?: string
		external?: {
			url: string
		}
		file?: {
			url: string
			expiry_time: string
		}
	}
	cover?: any
	properties: Record<string, any>
	parent: {
		type: string
		workspace: boolean
	}
	url: string
	archived: boolean
	is_inline: boolean
	public_url?: string
}

interface NotionSearchResponse {
	object: string
	results: NotionDatabase[]
	next_cursor?: string
	has_more: boolean
	type: string
	page_or_database: {}
	request_id: string
}

interface NotionPage {
	object: string
	id: string
	created_time: string
	last_edited_time: string
	created_by: {
		object: string
		id: string
	}
	last_edited_by: {
		object: string
		id: string
	}
	cover?: any
	icon?: any
	parent: {
		type: string
		database_id: string
	}
	archived: boolean
	properties: Record<string, any>
	url: string
	public_url?: string
}

interface NotionCreatePageResponse extends NotionPage {
	request_id: string
}

interface NotionErrorResponse {
	object: string
	status: number
	code: string
	message: string
	request_id: string
}

interface NotionConnectionConfig {
	databaseId?: string
	channelMetadata?: {
		url: string
	}
	defaultProperties?: Record<string, any>
	includeNoteContent?: boolean
}

/**
 * Notion integration provider
 */
export class NotionProvider extends BaseIntegrationProvider {
	readonly name = 'notion'
	readonly type = 'productivity' as const
	readonly displayName = 'Notion'
	readonly description =
		'Connect notes to Notion databases for knowledge management and collaboration'
	readonly logoPath = '/icons/notion.svg'

	private readonly apiBaseUrl = 'https://api.notion.com/v1'
	private readonly authBaseUrl = 'https://api.notion.com/v1/oauth'
	private readonly apiVersion = '2022-06-28'

	constructor() {
		super()
	}

	private get clientId(): string {
		const clientId = ENV.NOTION_CLIENT_ID
		if (!clientId) {
			throw new Error('NOTION_CLIENT_ID environment variable is required')
		}
		return clientId
	}

	private get clientSecret(): string {
		const clientSecret = ENV.NOTION_CLIENT_SECRET
		if (!clientSecret) {
			throw new Error('NOTION_CLIENT_SECRET environment variable is required')
		}
		return clientSecret
	}

	/**
	 * Generate Notion OAuth authorization URL
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
			owner: 'user',
		})

		return `${this.authBaseUrl}/authorize?${params.toString()}`
	}

	/**
	 * Handle OAuth callback and exchange code for tokens
	 */
	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const { code, state, organizationId } = params

		// Validate OAuth state
		const stateData = this.parseOAuthState(state)
		if (stateData.organizationId !== organizationId) {
			throw new Error('Invalid OAuth state: organization mismatch')
		}

		// Exchange code for access token
		// Notion requires HTTP Basic Auth (base64 encoded credentials) + JSON content
		// Based on: https://floppynaomi.github.io/blog/notion-oauth-node-express/
		const credentials = Buffer.from(
			`${this.clientId}:${this.clientSecret}`,
		).toString('base64')

		const tokenResponse = await fetch(`${this.authBaseUrl}/token`, {
			method: 'POST',
			headers: {
				Authorization: `Basic ${credentials}`,
				'Content-Type': 'application/json',
				'Notion-Version': this.apiVersion,
			},
			body: JSON.stringify({
				grant_type: 'authorization_code',
				code,
				redirect_uri: stateData.redirectUri,
			}),
		})

		if (!tokenResponse.ok) {
			const errorData = await tokenResponse.json().catch(() => ({}))
			console.error('Notion OAuth token exchange failed:', errorData)
			throw new Error(
				`Failed to exchange code for token: ${tokenResponse.status}`,
			)
		}

		const tokenData = (await tokenResponse.json()) as NotionOAuthResponse

		if (tokenData.error) {
			throw new Error(
				`Notion OAuth error: ${tokenData.error_description || tokenData.error}`,
			)
		}

		// Store configuration data for later use
		const config = {
			workspaceId: tokenData.workspace_id,
			workspaceName: tokenData.workspace_name,
			botId: tokenData.bot_id,
			user: {
				id: tokenData.owner.user?.id || '',
				name: tokenData.owner.user?.name || '',
				email: tokenData.owner.user?.person?.email,
				avatarUrl: tokenData.owner.user?.avatar_url,
			},
		}

		return {
			accessToken: tokenData.access_token,
			metadata: config,
		}
	}

	/**
	 * Refresh expired access token
	 * Note: Notion doesn't provide refresh tokens, so this will always throw
	 */
	async refreshToken(_refreshToken: string): Promise<TokenData> {
		throw new Error(
			'Notion does not support token refresh. Users must re-authenticate.',
		)
	}

	/**
	 * Get available databases (mapped as channels)
	 */
	async getAvailableChannels(integration: Integration): Promise<Channel[]> {
		if (!integration.accessToken) {
			throw new Error('No access token available')
		}

		try {
			// Decrypt the access token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(integration.accessToken)

			// Search for databases the integration has access to
			const response = await fetch(`${this.apiBaseUrl}/search`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json',
					'Notion-Version': this.apiVersion,
				},
				body: JSON.stringify({
					filter: {
						value: 'database',
						property: 'object',
					},
					sort: {
						direction: 'descending',
						timestamp: 'last_edited_time',
					},
				}),
			})

			if (!response.ok) {
				if (response.status === 401) {
					throw new Error('Notion access token is invalid or expired')
				}
				const errorData = (await response
					.json()
					.catch(() => ({}))) as NotionErrorResponse
				throw new Error(
					`Failed to fetch databases: ${errorData.message || response.statusText}`,
				)
			}

			const searchData = (await response.json()) as NotionSearchResponse

			return searchData.results.map((database) => ({
				id: database.id,
				name: this.getDatabaseTitle(database),
				type: 'public' as const,
				metadata: {
					url: database.url,
					icon: database.icon,
					lastEditedTime: database.last_edited_time,
				},
			}))
		} catch (error) {
			console.error('Error fetching Notion databases:', error)
			throw error
		}
	}

	/**
	 * Post a message (create a page) to a connected database
	 */
	async postMessage(
		connection: NoteIntegrationConnection & { integration: Integration },
		message: MessageData,
	): Promise<void> {
		if (!connection.integration.accessToken) {
			throw new Error('No access token available')
		}

		const connectionConfig = (
			typeof connection.config === 'string'
				? JSON.parse(connection.config)
				: (connection.config ?? {})
		) as NotionConnectionConfig

		// Extract database ID from the channel metadata URL
		let databaseId = connectionConfig?.databaseId
		if (!databaseId && connectionConfig?.channelMetadata?.url) {
			// Extract database ID from Notion URL: https://www.notion.so/{DATABASE_ID}
			const urlMatch = connectionConfig.channelMetadata.url.match(
				/notion\.so\/([a-f0-9]{32})/,
			)
			if (urlMatch) {
				databaseId = urlMatch[1]
			}
		}
		if (!databaseId) {
			throw new Error('No database ID configured for this connection')
		}

		try {
			// Decrypt the access token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(connection.integration.accessToken)
			// Create a new page in the database
			const pageData = {
				parent: {
					database_id: databaseId,
				},
				properties: {
					// Title property (most databases have this)
					Name: {
						title: [
							{
								text: {
									content: message.title,
								},
							},
						],
					},
					// Add any default properties from connection config
					...this.formatDefaultProperties(connectionConfig.defaultProperties),
				},
				children: connectionConfig.includeNoteContent
					? this.formatNoteContent(
							message.content,
							message.noteUrl,
							message.author,
						)
					: this.formatBasicContent(message.noteUrl, message.author),
			}

			const response = await fetch(`${this.apiBaseUrl}/pages`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json',
					'Notion-Version': this.apiVersion,
				},
				body: JSON.stringify(pageData),
			})

			if (!response.ok) {
				if (response.status === 401) {
					throw new Error('Notion access token is invalid or expired')
				}
				const errorData = (await response
					.json()
					.catch(() => ({}))) as NotionErrorResponse
				throw new Error(
					`Failed to create page: ${errorData.message || response.statusText}`,
				)
			}

			const createdPage = (await response.json()) as NotionCreatePageResponse
			console.log(`Successfully created Notion page: ${createdPage.url}`)
		} catch (error) {
			console.error('Error creating Notion page:', error)
			throw error
		}
	}

	/**
	 * Validate that a connection is still active and accessible
	 */
	async validateConnection(
		connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		if (!connection.integration.accessToken) {
			return false
		}

		const connectionConfig = (
			typeof connection.config === 'string'
				? JSON.parse(connection.config)
				: (connection.config ?? {})
		) as NotionConnectionConfig

		// Extract database ID from the channel metadata URL
		let databaseId = connectionConfig?.databaseId
		if (!databaseId && connectionConfig?.channelMetadata?.url) {
			// Extract database ID from Notion URL: https://www.notion.so/{DATABASE_ID}
			const urlMatch = connectionConfig.channelMetadata.url.match(
				/notion\.so\/([a-f0-9]{32})/,
			)
			if (urlMatch) {
				databaseId = urlMatch[1]
			}
		}
		if (!databaseId) {
			return false
		}

		try {
			// Decrypt the access token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(connection.integration.accessToken)

			// Try to retrieve the database to validate access
			const response = await fetch(
				`${this.apiBaseUrl}/databases/${databaseId}`,
				{
					method: 'GET',
					headers: {
						Authorization: `Bearer ${accessToken}`,
						'Notion-Version': this.apiVersion,
					},
				},
			)

			return response.ok
		} catch (error) {
			console.error('Error validating Notion connection:', error)
			return false
		}
	}

	/**
	 * Get provider-specific configuration schema
	 */
	getConfigSchema(): Record<string, any> {
		return {
			type: 'object',
			properties: {
				workspaceId: {
					type: 'string',
					title: 'Workspace ID',
					description: 'Notion workspace identifier',
				},
				workspaceName: {
					type: 'string',
					title: 'Workspace Name',
					description: 'Display name of the Notion workspace',
				},
				botId: {
					type: 'string',
					title: 'Bot ID',
					description: 'Notion integration bot identifier',
				},
				user: {
					type: 'object',
					title: 'User Information',
					properties: {
						id: {
							type: 'string',
							title: 'User ID',
						},
						name: {
							type: 'string',
							title: 'User Name',
						},
						email: {
							type: 'string',
							title: 'User Email',
							format: 'email',
						},
						avatarUrl: {
							type: 'string',
							title: 'Avatar URL',
							format: 'uri',
						},
					},
					required: ['id', 'name'],
				},
			},
			required: ['workspaceId', 'workspaceName', 'botId', 'user'],
		}
	}

	/**
	 * Helper method to extract database title from Notion database object
	 */
	private getDatabaseTitle(database: NotionDatabase): string {
		if (database.title && database.title.length > 0) {
			return database.title.map((t) => t.plain_text).join('')
		}
		return 'Untitled Database'
	}

	/**
	 * Helper method to format default properties for page creation
	 */
	private formatDefaultProperties(
		defaultProperties?: Record<string, any>,
	): Record<string, any> {
		if (!defaultProperties) {
			return {}
		}

		// Convert simple values to Notion property format
		const formatted: Record<string, any> = {}

		for (const [key, value] of Object.entries(defaultProperties)) {
			if (typeof value === 'string') {
				formatted[key] = {
					rich_text: [
						{
							text: {
								content: value,
							},
						},
					],
				}
			} else if (typeof value === 'number') {
				formatted[key] = {
					number: value,
				}
			} else if (typeof value === 'boolean') {
				formatted[key] = {
					checkbox: value,
				}
			}
			// Add more property type conversions as needed
		}

		return formatted
	}

	/**
	 * Helper method to format note content as Notion blocks
	 */
	private formatNoteContent(
		content: string,
		noteUrl: string,
		author: string,
	): any[] {
		const blocks: any[] = []

		// Add note content as paragraph blocks
		if (content) {
			// Split content into paragraphs and create blocks
			const paragraphs = content.split('\n\n').filter((p) => p.trim())

			for (const paragraph of paragraphs) {
				if (paragraph.trim()) {
					blocks.push({
						object: 'block',
						type: 'paragraph',
						paragraph: {
							rich_text: [
								{
									type: 'text',
									text: {
										content: paragraph.trim(),
									},
								},
							],
						},
					})
				}
			}
		}

		// Add metadata section
		blocks.push({
			object: 'block',
			type: 'divider',
			divider: {},
		})

		blocks.push({
			object: 'block',
			type: 'paragraph',
			paragraph: {
				rich_text: [
					{
						type: 'text',
						text: {
							content: `Created by: ${author}`,
						},
					},
				],
			},
		})

		blocks.push({
			object: 'block',
			type: 'paragraph',
			paragraph: {
				rich_text: [
					{
						type: 'text',
						text: {
							content: 'View original note: ',
						},
					},
					{
						type: 'text',
						text: {
							content: noteUrl,
							link: {
								url: noteUrl,
							},
						},
					},
				],
			},
		})

		return blocks
	}

	/**
	 * Helper method to format basic content without full note content
	 */
	private formatBasicContent(noteUrl: string, author: string): any[] {
		return [
			{
				object: 'block',
				type: 'paragraph',
				paragraph: {
					rich_text: [
						{
							type: 'text',
							text: {
								content: `A new note has been created by ${author}.`,
							},
						},
					],
				},
			},
			{
				object: 'block',
				type: 'paragraph',
				paragraph: {
					rich_text: [
						{
							type: 'text',
							text: {
								content: 'View the full note: ',
							},
						},
						{
							type: 'text',
							text: {
								content: noteUrl,
								link: {
									url: noteUrl,
								},
							},
						},
					],
				},
			},
		]
	}
}
