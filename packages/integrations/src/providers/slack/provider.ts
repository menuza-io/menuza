/**
 * Slack integration provider implementation
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
 * Slack API response interfaces
 */
interface SlackOAuthResponse {
	app_id: string
	ok: boolean
	access_token?: string
	scope?: string
	team?: {
		id: string
		name: string
	}
	bot_user_id?: string
	error?: string
}

interface SlackChannelsResponse {
	ok: boolean
	channels?: Array<{
		id: string
		name: string
		is_private: boolean
		is_archived: boolean
		is_member: boolean
		num_members?: number
		purpose?: {
			value: string
			creator: string
			last_set: number
		}
		topic?: {
			value: string
			creator: string
			last_set: number
		}
	}>
	error?: string
	response_metadata?: {
		next_cursor?: string
	}
}

interface SlackPostMessageResponse {
	ok: boolean
	ts?: string
	error?: string
}

/**
 * Slack integration provider
 */
export class SlackProvider extends BaseIntegrationProvider {
	readonly name = 'slack'
	readonly type = 'communication' as const
	readonly displayName = 'Slack'
	readonly description =
		'Connect notes to Slack channels for team collaboration'
	readonly logoPath = '/icons/slack.svg'

	private get clientId(): string {
		const clientId = ENV.SLACK_CLIENT_ID
		if (!clientId) {
			console.warn(
				'SLACK_CLIENT_ID not found in environment variables, using demo client ID',
			)
			return 'demo-slack-client-id'
		}
		return clientId
	}

	private get clientSecret(): string {
		const clientSecret = ENV.SLACK_CLIENT_SECRET
		if (!clientSecret) {
			console.warn(
				'SLACK_CLIENT_SECRET not found in environment variables, using demo client secret',
			)
			return 'demo-slack-client-secret'
		}
		return clientSecret
	}

	/**
	 * Generate Slack OAuth authorization URL
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
			scope: 'channels:read,chat:write,channels:history,groups:read',
			redirect_uri: redirectUri,
			state,
			response_type: 'code',
		})

		return `https://slack.com/oauth/v2/authorize?${params.toString()}`
	}

	/**
	 * Handle OAuth callback and exchange code for tokens
	 */
	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const { code, state } = params

		try {
			this.parseOAuthState(state)
		} catch (error) {
			throw new Error(
				`Invalid OAuth state: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}

		const hasRealCredentials =
			this.clientId !== 'demo-slack-client-id' &&
			this.clientSecret !== 'demo-slack-client-secret'

		if (!hasRealCredentials) {
			return {
				accessToken: `mock-slack-token-${Date.now()}`,
				scope: 'channels:read,chat:write,channels:history,groups:read',
				metadata: {
					teamId: 'T1234567890',
					teamName: 'Demo Team',
					botUserId: 'U1234567890',
				},
			}
		}

		try {
			const response = await fetch('https://slack.com/api/oauth.v2.access', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					code,
				}),
			})

			if (!response.ok) {
				throw new Error(
					`Slack OAuth API error: ${response.status} ${response.statusText}`,
				)
			}

			const data = (await response.json()) as SlackOAuthResponse

			if (!data.ok || !data.access_token) {
				throw new Error(`Slack OAuth error: ${data.error || 'Unknown error'}`)
			}

			return {
				accessToken: data.access_token,
				scope: data.scope,
				metadata: {
					teamId: data.team?.id,
					teamName: data.team?.name,
					botUserId: data.bot_user_id,
				},
			}
		} catch (error) {
			console.error('Error exchanging OAuth code for Slack token:', error)
			throw new Error(
				`Failed to exchange OAuth code: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Refresh Slack access token
	 */
	async refreshToken(_refreshToken: string): Promise<TokenData> {
		throw new Error('Slack bot tokens do not require refresh')
	}

	/**
	 * Get available Slack channels using shared makeAuthenticatedRequest
	 */
	async getAvailableChannels(integration: Integration): Promise<Channel[]> {
		try {
			const accessToken = integration.accessToken
			if (!accessToken) {
				throw new Error('No access token available for Slack integration')
			}

			if (accessToken.startsWith('mock-slack-token-')) {
				return [
					{
						id: 'C1234567890',
						name: 'general',
						type: 'public',
						metadata: {
							is_member: true,
							member_count: 42,
							purpose: 'General discussion for the team',
							demo: true,
						},
					},
					{
						id: 'C0987654321',
						name: 'random',
						type: 'public',
						metadata: {
							is_member: true,
							member_count: 25,
							purpose: 'Random conversations and fun',
							demo: true,
						},
					},
					{
						id: 'C1122334455',
						name: 'dev-team',
						type: 'private',
						metadata: {
							is_member: true,
							member_count: 8,
							purpose: 'Development team discussions',
							demo: true,
						},
					},
				]
			}

			let allChannels: SlackChannelsResponse['channels'] = []
			let cursor: string | undefined = undefined

			do {
				const channelsUrl = new URL('https://slack.com/api/conversations.list')
				channelsUrl.searchParams.set('types', 'public_channel,private_channel')
				channelsUrl.searchParams.set('exclude_archived', 'true')
				channelsUrl.searchParams.set('limit', '200')

				if (cursor) {
					channelsUrl.searchParams.set('cursor', cursor)
				}

				const channelsResponse = await this.makeAuthenticatedRequest(
					integration,
					channelsUrl.toString(),
					{
						method: 'GET',
						headers: {
							'Content-Type': 'application/json',
						},
					},
				)

				if (!channelsResponse.ok) {
					const errorText = await channelsResponse.text()
					console.error(
						'Slack API HTTP error:',
						channelsResponse.status,
						channelsResponse.statusText,
						errorText,
					)
					throw new Error(
						`Slack API error: ${channelsResponse.status} ${channelsResponse.statusText}`,
					)
				}

				const channelsData =
					(await channelsResponse.json()) as SlackChannelsResponse

				if (!channelsData.ok) {
					console.error('Slack API response error:', channelsData.error)
					throw new Error(
						`Slack API error: ${channelsData.error || 'Unknown error'}`,
					)
				}

				if (channelsData.channels) {
					allChannels.push(...channelsData.channels)
				}

				cursor = channelsData.response_metadata?.next_cursor

				if (allChannels.length > 1000) {
					console.warn('Reached channel limit of 1000, stopping pagination')
					break
				}
			} while (cursor)

			const channels: Channel[] = allChannels
				.filter((channel) => !channel.is_archived)
				.map(
					(channel) =>
						({
							id: channel.id,
							name: channel.name,
							type: channel.is_private ? 'private' : 'public',
							metadata: {
								is_member: channel.is_member,
								is_archived: channel.is_archived,
								is_private: channel.is_private,
								member_count: channel.num_members || 0,
								purpose: channel.purpose?.value || '',
								topic: channel.topic?.value || '',
								bot_needs_invite: !channel.is_member,
								can_post: true,
							},
						}) as Channel,
				)
				.sort((a, b) => a.name.localeCompare(b.name))
			return channels
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'
			console.error('Error fetching Slack channels:', errorMessage)

			if (
				errorMessage.includes('invalid_auth') ||
				errorMessage.includes('token_revoked')
			) {
				return [
					{
						id: 'C1234567890',
						name: 'general',
						type: 'public',
						metadata: {
							is_member: true,
							member_count: 42,
							purpose: 'General discussion (Demo)',
							demo: true,
							auth_error: true,
						},
					},
					{
						id: 'C0987654321',
						name: 'random',
						type: 'public',
						metadata: {
							is_member: true,
							member_count: 25,
							purpose: 'Random conversations (Demo)',
							demo: true,
							auth_error: true,
						},
					},
				]
			}

			if (errorMessage.includes('missing_scope')) {
				throw new Error(
					'Slack integration is missing required permissions. Please reconnect with proper scopes.',
				)
			}

			return [
				{
					id: 'C1234567890',
					name: 'general',
					type: 'public',
					metadata: {
						is_member: true,
						member_count: 42,
						purpose: 'General discussion (Fallback)',
						demo: true,
						fallback_reason: errorMessage,
					},
				},
			]
		}
	}

	/**
	 * Post a message to a Slack channel using makeAuthenticatedRequest
	 */
	async postMessage(
		connection: NoteIntegrationConnection & { integration: Integration },
		message: MessageData,
	): Promise<void> {
		try {
			const accessToken = connection.integration.accessToken

			if (!accessToken) {
				throw new Error('No access token available for Slack integration')
			}

			if (accessToken.startsWith('mock-slack-token-')) {
				return
			}

			const connectionConfig = connection.config
				? JSON.parse(connection.config as string)
				: {}
			const useBlocks = (connectionConfig as any).postFormat !== 'text'
			const includeContent = (connectionConfig as any).includeContent !== false

			const payload: any = {
				channel: connection.externalId,
				username: 'Note Bot',
				icon_emoji: ':memo:',
			}

			if (useBlocks) {
				payload.blocks = this.formatSlackBlocks(message, includeContent)
				payload.text = `${this.getChangeTypeEmoji(message.changeType)} ${message.title} was ${message.changeType} by ${message.author}`
			} else {
				payload.text = this.formatSlackText(message, includeContent)
			}

			const response = await this.makeAuthenticatedRequest(
				connection.integration,
				'https://slack.com/api/chat.postMessage',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(payload),
				},
			)

			if (!response.ok) {
				throw new Error(
					`Slack API HTTP error: ${response.status} ${response.statusText}`,
				)
			}

			const data = (await response.json()) as SlackPostMessageResponse

			if (!data.ok) {
				throw new Error(`Slack API error: ${data.error || 'Unknown error'}`)
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'

			if (errorMessage.includes('channel_not_found')) {
				throw new Error(
					'Slack channel not found. The channel may have been deleted or renamed.',
				)
			} else if (errorMessage.includes('not_in_channel')) {
				throw new Error(
					'Bot is not a member of this Slack channel. Please invite the bot to the channel.',
				)
			} else if (errorMessage.includes('channel_is_archived')) {
				throw new Error('Cannot post to archived Slack channel.')
			} else if (errorMessage.includes('msg_too_long')) {
				throw new Error(
					'Message is too long for Slack. Please shorten the note content.',
				)
			} else if (errorMessage.includes('rate_limited')) {
				throw new Error(
					'Slack API rate limit exceeded. Please try again later.',
				)
			} else if (errorMessage.includes('invalid_auth')) {
				throw new Error(
					'Slack authentication failed. Please reconnect your Slack integration.',
				)
			} else if (errorMessage.includes('invalid_blocks')) {
				throw new Error(
					'Invalid Slack message format. This might be due to an invalid URL or block structure.',
				)
			}

			throw error
		}
	}

	/**
	 * Validate a Slack connection
	 */
	async validateConnection(
		_connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		return true
	}

	/**
	 * Get Slack provider configuration schema
	 */
	getConfigSchema(): Record<string, any> {
		return {
			type: 'object',
			properties: {
				teamId: { type: 'string', description: 'Slack team ID' },
				teamName: { type: 'string', description: 'Slack team name' },
				botUserId: { type: 'string', description: 'Bot user ID' },
				scope: { type: 'string', description: 'OAuth scope' },
			},
			required: ['teamId', 'teamName', 'scope'],
		}
	}

	/**
	 * Format message for Slack blocks
	 */
	private formatSlackBlocks(
		message: MessageData,
		includeContent: boolean = true,
	): any[] {
		const changeTypeEmoji = this.getChangeTypeEmoji(message.changeType)

		const blocks: any[] = [
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: `${changeTypeEmoji} *${message.title}* was ${message.changeType} by *${message.author}*`,
				},
			},
		]

		if (includeContent && message.content && message.content.trim()) {
			blocks.push({
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: this.truncateContent(message.content, 500),
				},
			})
		}

		if (this.isValidUrl(message.noteUrl)) {
			blocks.push({
				type: 'actions',
				elements: [
					{
						type: 'button',
						text: {
							type: 'plain_text',
							text: 'View Note',
							emoji: true,
						},
						url: message.noteUrl,
						style: 'primary',
					},
				],
			})
		} else {
			blocks.push({
				type: 'context',
				elements: [
					{
						type: 'mrkdwn',
						text: `View Note: ${message.noteUrl}`,
					},
				],
			})
		}

		blocks.push({
			type: 'divider',
		})

		return blocks
	}

	/**
	 * Format message as plain text for Slack
	 */
	private formatSlackText(
		message: MessageData,
		includeContent: boolean = true,
	): string {
		const changeTypeEmoji = this.getChangeTypeEmoji(message.changeType)

		let text = `${changeTypeEmoji} *${message.title}* was ${message.changeType} by ${message.author}`

		if (includeContent && message.content && message.content.trim()) {
			text += `\n\n${this.truncateContent(message.content, 300)}`
		}

		text += `\n\n<${message.noteUrl}|View Note>`

		return text
	}

	/**
	 * Get emoji for change type
	 */
	private getChangeTypeEmoji(changeType: MessageData['changeType']): string {
		const changeTypeEmojis = {
			created: '✨',
			updated: '📝',
			deleted: '🗑️',
		}
		return changeTypeEmojis[changeType] || '📄'
	}

	/**
	 * Check if URL is valid for Slack buttons (must be absolute)
	 */
	private isValidUrl(url: string): boolean {
		try {
			const parsedUrl = new URL(url)
			return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:'
		} catch {
			return false
		}
	}

	/**
	 * Truncate content for Slack message
	 */
	private truncateContent(content: string, maxLength: number = 300): string {
		if (!content || content.length <= maxLength) {
			return content || ''
		}

		const truncated = content.substring(0, maxLength - 3)
		const lastSpace = truncated.lastIndexOf(' ')

		if (lastSpace > maxLength * 0.8) {
			return truncated.substring(0, lastSpace) + '...'
		} else {
			return truncated + '...'
		}
	}
}
