/**
 * Trello integration provider implementation
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
import crypto from 'crypto'

// Simple in-memory storage for OAuth 1.0a request tokens
// In production, this should be stored in a database or cache with TTL
const requestTokenStorage = new Map<
	string,
	{
		organizationId: string
		requestTokenSecret: string
		timestamp: number
	}
>()

/**
 * Trello API response interfaces
 */
interface TrelloUser {
	id: string
	username: string
	fullName: string
	email?: string
	avatarUrl?: string
	url: string
}

interface TrelloBoard {
	id: string
	name: string
	url: string
	closed: boolean
	desc: string
	prefs: {
		permissionLevel: string
		background: string
	}
}

interface TrelloList {
	id: string
	name: string
	closed: boolean
	pos: number
	idBoard: string
}

interface TrelloApiError {
	message: string
	error: string
}

/**
 * Trello integration provider
 */
export class TrelloProvider extends BaseIntegrationProvider {
	readonly name = 'trello'
	readonly type = 'productivity' as const
	readonly displayName = 'Trello'
	readonly description =
		'Connect notes to Trello boards for task management and project organization'
	readonly logoPath = '/icons/trello.svg'

	private readonly apiBaseUrl = 'https://api.trello.com/1'
	private readonly authBaseUrl = 'https://trello.com/1'

	constructor() {
		super()
	}

	private get apiKey(): string {
		const apiKey = ENV.TRELLO_API_KEY
		if (!apiKey) {
			throw new Error('TRELLO_API_KEY environment variable is required')
		}
		return apiKey
	}

	private get apiSecret(): string {
		const apiSecret = ENV.TRELLO_API_SECRET
		if (!apiSecret) {
			throw new Error('TRELLO_API_SECRET environment variable is required')
		}
		return apiSecret
	}

	/**
	 * Store request token context for OAuth 1.0a flow
	 */
	async storeRequestTokenContext(
		requestToken: string,
		context: {
			organizationId: string
			requestTokenSecret: string
			timestamp: number
		},
	): Promise<void> {
		// Store with 1 hour TTL
		requestTokenStorage.set(requestToken, context)

		// Clean up expired tokens (older than 1 hour)
		setTimeout(
			() => {
				const now = Date.now()
				for (const [token, ctx] of requestTokenStorage.entries()) {
					if (now - ctx.timestamp > 60 * 60 * 1000) {
						// 1 hour
						requestTokenStorage.delete(token)
					}
				}
			},
			60 * 60 * 1000,
		) // Clean up after 1 hour
	}

	/**
	 * Retrieve request token context for OAuth 1.0a flow
	 */
	public async getRequestTokenContext(requestToken: string): Promise<{
		organizationId: string
		requestTokenSecret: string
		timestamp: number
	} | null> {
		const context = requestTokenStorage.get(requestToken)
		if (!context) {
			return null
		}

		// Check if expired (1 hour)
		if (Date.now() - context.timestamp > 60 * 60 * 1000) {
			requestTokenStorage.delete(requestToken)
			return null
		}

		return context
	}

	/**
	 * Generate OAuth 1.0a signature for Trello API
	 */
	private generateOAuthSignature(
		method: string,
		url: string,
		params: Record<string, string>,
		tokenSecret?: string,
	): string {
		// Sort parameters
		const sortedParams = Object.keys(params)
			.sort()
			.map(
				(key) =>
					`${encodeURIComponent(key)}=${encodeURIComponent(params[key] || '')}`,
			)
			.join('&')

		// Create signature base string
		const signatureBaseString = [
			method.toUpperCase(),
			encodeURIComponent(url),
			encodeURIComponent(sortedParams),
		].join('&')

		// Create signing key
		const signingKey = `${encodeURIComponent(this.apiSecret)}&${encodeURIComponent(tokenSecret || '')}`

		// Generate signature
		const signature = crypto
			.createHmac('sha1', signingKey)
			.update(signatureBaseString)
			.digest('base64')

		return signature
	}

	/**
	 * Generate Trello OAuth authorization URL
	 */
	async getAuthUrl(
		organizationId: string,
		redirectUri: string,
		_additionalParams?: Record<string, any>,
	): Promise<string> {
		try {
			// Step 1: Get request token
			const requestTokenParams: Record<string, string> = {
				oauth_callback: redirectUri,
				oauth_consumer_key: this.apiKey,
				oauth_nonce: crypto.randomBytes(16).toString('hex'),
				oauth_signature_method: 'HMAC-SHA1',
				oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
				oauth_version: '1.0',
			}

			const requestTokenUrl = `${this.authBaseUrl}/OAuthGetRequestToken`
			const signature = this.generateOAuthSignature(
				'POST',
				requestTokenUrl,
				requestTokenParams,
			)
			requestTokenParams.oauth_signature = signature

			const requestTokenResponse = await fetch(requestTokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams(requestTokenParams).toString(),
			})

			if (!requestTokenResponse.ok) {
				const errorText = await requestTokenResponse.text()
				throw new Error(`Failed to get request token: ${errorText}`)
			}

			const requestTokenData = await requestTokenResponse.text()
			const requestTokenParams2 = new URLSearchParams(requestTokenData)
			const requestToken = requestTokenParams2.get('oauth_token')
			const requestTokenSecret = requestTokenParams2.get('oauth_token_secret')

			if (!requestToken || !requestTokenSecret) {
				throw new Error('Failed to get request token from Trello')
			}

			// Store the organization context with the request token for later retrieval
			// In a production app, you'd store this in a database or cache
			// For now, we'll use a simple in-memory storage approach
			await this.storeRequestTokenContext(requestToken, {
				organizationId,
				requestTokenSecret,
				timestamp: Date.now(),
			})

			// Step 2: Generate authorization URL
			const authParams = new URLSearchParams({
				oauth_token: requestToken,
				name: 'Epic Stack Integration',
				scope: 'read,write',
				expiration: 'never',
				response_type: 'fragment',
			})

			return `${this.authBaseUrl}/authorize?${authParams.toString()}`
		} catch (error) {
			console.error('Trello auth URL generation failed:', error)
			throw new Error(
				`Failed to generate Trello auth URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Handle OAuth callback and exchange code for tokens
	 */
	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const { code: oauthVerifier, oauthToken } = params

		if (!oauthVerifier) {
			throw new Error('OAuth verifier is required')
		}

		if (!oauthToken) {
			throw new Error('OAuth token is required for OAuth 1.0a flow')
		}

		try {
			// Get the stored request token context
			const tokenContext = await this.getRequestTokenContext(oauthToken)
			if (!tokenContext) {
				throw new Error('Request token context not found or expired')
			}

			// Step 3: Exchange verifier for access token
			const accessTokenParams: Record<string, string> = {
				oauth_consumer_key: this.apiKey,
				oauth_token: oauthToken,
				oauth_verifier: oauthVerifier,
				oauth_nonce: crypto.randomBytes(16).toString('hex'),
				oauth_signature_method: 'HMAC-SHA1',
				oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
				oauth_version: '1.0',
			}

			const accessTokenUrl = `${this.authBaseUrl}/OAuthGetAccessToken`

			// Generate signature using request token secret
			const tokenSecret = tokenContext.requestTokenSecret
			const signature = this.generateOAuthSignature(
				'POST',
				accessTokenUrl,
				accessTokenParams,
				tokenSecret,
			)
			accessTokenParams.oauth_signature = signature

			const accessTokenResponse = await fetch(accessTokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams(accessTokenParams).toString(),
			})

			if (!accessTokenResponse.ok) {
				const errorText = await accessTokenResponse.text()
				throw new Error(`Failed to get access token: ${errorText}`)
			}

			const accessTokenData = await accessTokenResponse.text()
			const accessTokenParams2 = new URLSearchParams(accessTokenData)
			const accessToken = accessTokenParams2.get('oauth_token')
			const accessTokenSecret = accessTokenParams2.get('oauth_token_secret')

			if (!accessToken || !accessTokenSecret) {
				throw new Error('Failed to get access token from Trello')
			}

			// Clean up the stored request token
			requestTokenStorage.delete(oauthToken)

			return {
				accessToken,
				refreshToken: accessTokenSecret, // Store token secret as refresh token
				// Trello tokens don't expire, so no expiresAt date
			}
		} catch (error) {
			console.error('Trello OAuth callback failed:', error)
			throw new Error(
				`Trello OAuth callback failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Refresh Trello access token
	 * Note: Trello tokens don't expire by default, so this is a no-op
	 */
	async refreshToken(refreshToken: string): Promise<TokenData> {
		// Trello tokens don't expire, so we just return the existing token
		return {
			accessToken: refreshToken,
			// No refresh token needed for Trello
		}
	}

	/**
	 * Get available Trello boards and lists (mapped as channels)
	 */
	async getAvailableChannels(integration: Integration): Promise<Channel[]> {
		try {
			if (!integration.accessToken) {
				throw new Error('No access token available for Trello integration')
			}

			// Decrypt the stored access token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(integration.accessToken)

			if (!accessToken) {
				throw new Error('No access token available for Trello integration')
			}

			const channels: Channel[] = []

			// Get user's boards
			const boardsUrl = new URL(`${this.apiBaseUrl}/members/me/boards`)
			boardsUrl.searchParams.set('key', this.apiKey)
			boardsUrl.searchParams.set('token', accessToken)
			boardsUrl.searchParams.set('filter', 'open')

			const boardsResponse = await fetch(boardsUrl.toString())

			if (!boardsResponse.ok) {
				let errorMessage = `Failed to fetch boards (${boardsResponse.status} ${boardsResponse.statusText})`
				try {
					// Try to parse as JSON first
					const errorData = (await boardsResponse.json()) as TrelloApiError
					errorMessage = `Failed to fetch boards: ${errorData.message || errorData.error || 'Unknown error'}`
				} catch {
					// If JSON parsing fails, try to get plain text error
					try {
						const errorText = await boardsResponse.text()
						if (errorText) {
							errorMessage = `Failed to fetch boards: ${errorText}`
						}
					} catch {
						// If both fail, use the status text
					}
				}
				throw new Error(errorMessage)
			}

			const boards = (await boardsResponse.json()) as TrelloBoard[]

			// For each board, get its lists
			for (const board of boards) {
				// Get lists for this board
				const listsUrl = new URL(`${this.apiBaseUrl}/boards/${board.id}/lists`)
				listsUrl.searchParams.set('key', this.apiKey)
				listsUrl.searchParams.set('token', accessToken)
				listsUrl.searchParams.set('filter', 'open')

				const listsResponse = await fetch(listsUrl.toString())

				if (listsResponse.ok) {
					const lists = (await listsResponse.json()) as TrelloList[]

					for (const list of lists) {
						channels.push({
							id: list.id,
							name: `${board.name} / ${list.name}`,
							type: 'public',
							metadata: {
								boardId: board.id,
								boardName: board.name,
								listName: list.name,
								boardUrl: board.url,
							},
						})
					}
				}
			}

			return channels
		} catch (error) {
			console.error('Failed to get Trello channels:', error)
			throw new Error(
				`Failed to get Trello channels: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Post a message to Trello by creating a card
	 */
	async postMessage(
		connection: NoteIntegrationConnection & { integration: Integration },
		message: MessageData,
	): Promise<void> {
		try {
			if (!connection.integration.accessToken) {
				throw new Error('No access token available for Trello integration')
			}

			// Decrypt the stored access token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(connection.integration.accessToken)

			if (!accessToken) {
				throw new Error('No access token available for Trello integration')
			}

			const connectionConfig = this.parseConnectionConfig(connection.config)

			// If listId is empty, try to use externalId as fallback
			if (!connectionConfig.listId && connection.externalId) {
				connectionConfig.listId = connection.externalId
			}

			if (!connectionConfig.listId) {
				throw new Error(
					'No list ID found in connection configuration. Please reconfigure the Trello integration.',
				)
			}

			// Create card description
			let description = `**Created by:** ${message.author}\n\n`

			if (connectionConfig.includeNoteContent && message.content) {
				description += `**Content:**\n${message.content}\n\n`
			}

			description += `**Source:** [View Note](${message.noteUrl})\n`
			description += `**Change Type:** ${message.changeType}`

			// Create the card
			const cardData: Record<string, string> = {
				name: message.title,
				desc: description,
				idList: connectionConfig.listId,
				key: this.apiKey,
				token: accessToken,
			}

			// Add default members if configured
			if (
				connectionConfig.defaultMembers &&
				connectionConfig.defaultMembers.length > 0
			) {
				cardData.idMembers = connectionConfig.defaultMembers.join(',')
			}

			// Add default labels if configured
			if (
				connectionConfig.defaultLabels &&
				connectionConfig.defaultLabels.length > 0
			) {
				cardData.idLabels = connectionConfig.defaultLabels.join(',')
			}

			// Add default members if configured
			if (
				connectionConfig.defaultMembers &&
				connectionConfig.defaultMembers.length > 0
			) {
				cardData.idMembers = connectionConfig.defaultMembers.join(',')
			}

			const response = await fetch(`${this.apiBaseUrl}/cards`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams(cardData).toString(),
			})

			if (!response.ok) {
				let errorMessage = `Failed to create card (${response.status} ${response.statusText})`
				try {
					// Try to parse as JSON first
					const errorData = (await response.json()) as TrelloApiError
					errorMessage = `Failed to create card: ${errorData.message || errorData.error || 'Unknown error'}`
				} catch {
					// If JSON parsing fails, try to get plain text error
					try {
						const errorText = await response.text()
						if (errorText) {
							errorMessage = `Failed to create card: ${errorText}`
						}
					} catch {
						// If both fail, use the status text
					}
				}
				throw new Error(errorMessage)
			}
		} catch (error) {
			throw new Error(
				`Failed to post message to Trello: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Validate a Trello connection
	 */
	async validateConnection(
		connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		try {
			if (!connection.integration.accessToken) {
				return false
			}

			// Decrypt the stored access token
			const { decryptToken } = await import('../../encryption')
			const accessToken = await decryptToken(connection.integration.accessToken)

			if (!accessToken) {
				throw new Error('No access token available for Trello integration')
			}

			const connectionConfig = this.parseConnectionConfig(connection.config)

			// Check if we can access the specified list
			const response = await fetch(
				`${this.apiBaseUrl}/lists/${connectionConfig.listId}?key=${this.apiKey}&token=${accessToken}`,
			)

			return response.ok
		} catch (error) {
			console.error('Trello connection validation failed:', error)
			return false
		}
	}

	/**
	 * Get Trello provider configuration schema
	 */
	getConfigSchema(): Record<string, any> {
		return {
			type: 'object',
			properties: {
				user: {
					type: 'object',
					properties: {
						id: { type: 'string' },
						username: { type: 'string' },
						fullName: { type: 'string' },
						email: { type: 'string' },
						avatarUrl: { type: 'string' },
					},
					required: ['id', 'username', 'fullName'],
				},
				boards: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							name: { type: 'string' },
							url: { type: 'string' },
						},
						required: ['id', 'name', 'url'],
					},
				},
			},
			required: ['user'],
		}
	}

	/**
	 * Parse connection configuration
	 */
	private parseConnectionConfig(config: any): {
		listId: string
		listName: string
		boardName: string
		includeNoteContent: boolean
		defaultLabels?: string[]
		defaultMembers?: string[]
	} {
		const parsed = typeof config === 'string' ? JSON.parse(config) : config
		return {
			listId: parsed.listId || '',
			listName: parsed.listName || '',
			boardName: parsed.boardName || '',
			includeNoteContent: parsed.includeNoteContent ?? true,
			defaultLabels: parsed.defaultLabels || [],
			defaultMembers: parsed.defaultMembers || [],
		}
	}

	/**
	 * Get user information from Trello
	 */
	private async getUserInfo(accessToken: string): Promise<TrelloUser> {
		const response = await fetch(
			`${this.apiBaseUrl}/members/me?key=${this.apiKey}&token=${accessToken}&fields=id,username,fullName,email,avatarUrl,url`,
		)

		if (!response.ok) {
			const errorData = (await response.json()) as TrelloApiError
			throw new Error(
				`Failed to get user info: ${errorData.message || 'Unknown error'}`,
			)
		}

		return (await response.json()) as TrelloUser
	}

	/**
	 * Get user's boards from Trello
	 */
	private async getUserBoards(accessToken: string): Promise<TrelloBoard[]> {
		const response = await fetch(
			`${this.apiBaseUrl}/members/me/boards?key=${this.apiKey}&token=${accessToken}&filter=open&fields=id,name,url,closed,desc,prefs`,
		)

		if (!response.ok) {
			const errorData = (await response.json()) as TrelloApiError
			throw new Error(
				`Failed to get boards: ${errorData.message || 'Unknown error'}`,
			)
		}

		return (await response.json()) as TrelloBoard[]
	}
}
