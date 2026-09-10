/**
 * Integration Manager - Core service for managing third-party integrations
 *
 * This service provides comprehensive integration management including:
 * - Provider registry management
 * - Integration CRUD operations
 * - Note-to-channel connection management
 * - OAuth flow coordination
 * - Token management and refresh
 * - Message posting and notification handling
 */

import { ENV } from './package-env.ts'
import {
	Integration as IntegrationTable,
	IntegrationLog as IntegrationLogTable,
	NoteIntegrationConnection as ConnectionTable,
	Organization as OrganizationTable,
	OrganizationNote as NoteTable,
	and,
	count,
	db,
	desc,
	eq,
	gte,
	inArray,
} from '@repo/database'
import {
	type Integration,
	type NoteIntegrationConnection,
	type OrganizationNote,
	type Organization,
} from './database-types'
import { type IntegrationProvider, providerRegistry } from './provider'
import {
	type TokenData,
	type Channel,
	type OAuthCallbackParams,
	type IntegrationStatus,
	type ProviderType,
	type IntegrationLogEntry,
} from './types'

/**
 * Extended Integration type with relations
 */
export type IntegrationWithRelations = Integration & {
	organization?: Organization
	connections?: (NoteIntegrationConnection & {
		note?: OrganizationNote
	})[]
}

/**
 * Extended Connection type with relations
 */
export type ConnectionWithRelations = NoteIntegrationConnection & {
	integration: Integration
	note?: OrganizationNote
}

/**
 * Integration creation parameters
 */
export interface CreateIntegrationParams {
	organizationId: string
	providerName: string
	tokenData: TokenData
	config?: Record<string, any>
}

/**
 * Connection creation parameters
 */
export interface CreateConnectionParams {
	noteId: string
	integrationId: string
	externalId: string
	config?: Record<string, any>
}

/**
 * Integration statistics
 */
export interface IntegrationStats {
	totalConnections: number
	activeConnections: number
	recentActivity: number
	lastActivity?: Date
	errorCount: number
}

/**
 * Main Integration Manager class
 *
 * Provides centralized management of all integration operations including
 * provider registry, OAuth flows, CRUD operations, and message handling.
 */
export class IntegrationManager {
	private static instance: IntegrationManager

	/**
	 * Get singleton instance of IntegrationManager
	 */
	static getInstance(): IntegrationManager {
		if (!IntegrationManager.instance) {
			IntegrationManager.instance = new IntegrationManager()
		}
		return IntegrationManager.instance
	}

	// Provider Registry Management

	/**
	 * Register a new integration provider
	 * @param provider - Provider instance to register
	 */
	registerProvider(provider: IntegrationProvider): void {
		providerRegistry.register(provider)
	}

	/**
	 * Get a provider by name
	 * @param name - Provider name
	 * @returns Provider instance
	 * @throws Error if provider not found
	 */
	getProvider(name: string): IntegrationProvider {
		return providerRegistry.get(name)
	}

	/**
	 * Get all registered providers
	 * @returns Array of all providers
	 */
	getAllProviders(): IntegrationProvider[] {
		return providerRegistry.getAll()
	}

	/**
	 * Get providers by type
	 * @param type - Provider type to filter by
	 * @returns Array of providers matching the type
	 */
	getProvidersByType(type: ProviderType): IntegrationProvider[] {
		return providerRegistry.getByType(type)
	}

	// OAuth Flow Management

	/**
	 * Initiate OAuth flow for a provider
	 * @param organizationId - Organization ID
	 * @param providerName - Name of the provider to connect
	 * @param redirectUri - OAuth callback URI
	 * @param additionalParams - Provider-specific parameters
	 * @returns Object containing authorization URL and state
	 */
	async initiateOAuth(
		organizationId: string,
		providerName: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<{
		authUrl: string
		state: string
	}> {
		const { oauthFlow } = await import('./oauth-flow')
		return oauthFlow.start(
			organizationId,
			providerName,
			redirectUri,
			additionalParams,
		)
	}

	/**
	 * Handle OAuth callback and create integration
	 * @param providerName - Provider name
	 * @param params - OAuth callback parameters
	 * @returns Created integration
	 */
	async handleOAuthCallback(
		providerName: string,
		params: OAuthCallbackParams,
	): Promise<Integration> {
		const { oauthFlow } = await import('./oauth-flow')
		return oauthFlow.complete(providerName, params)
	}

	// Integration CRUD Operations

	/**
	 * Create a new integration
	 * @param params - Integration creation parameters
	 * @returns Created integration
	 */
	async createIntegration(
		params: CreateIntegrationParams,
	): Promise<Integration> {
		const { organizationId, providerName, tokenData, config = {} } = params

		const provider = this.getProvider(providerName)

		// Encrypt tokens before storing in database
		const { encryptToken } = await import('./encryption')
		const encryptedAccessToken = await encryptToken(tokenData.accessToken)
		const encryptedRefreshToken = tokenData.refreshToken
			? await encryptToken(tokenData.refreshToken)
			: null

		// Create integration record
		const [integration] = await db
			.insert(IntegrationTable)
			.values({
				organizationId,
				providerName,
				providerType: provider.type,
				accessToken: encryptedAccessToken,
				refreshToken: encryptedRefreshToken,
				tokenExpiresAt: tokenData.expiresAt,
				config: JSON.stringify({
					...config,
					scope: tokenData.scope,
					metadata: tokenData.metadata || {},
				}),
				isActive: true,
				lastSyncAt: new Date(),
			})
			.returning()

		if (!integration) {
			throw new Error('Failed to create integration')
		}
		return integration
	}

	/**
	 * Get integration by ID
	 * @param integrationId - Integration ID
	 * @returns Integration with relations
	 */
	async getIntegration(
		integrationId: string,
	): Promise<IntegrationWithRelations | null> {
		const [integration] = await db
			.select()
			.from(IntegrationTable)
			.where(eq(IntegrationTable.id, integrationId))
			.limit(1)

		return integration ? this.hydrateIntegration(integration) : null
	}

	/**
	 * Get all integrations for an organization
	 * @param organizationId - Organization ID
	 * @param type - Optional provider type filter
	 * @returns List of integrations
	 */
	async getOrganizationIntegrations(
		organizationId: string,
		type?: ProviderType,
	): Promise<IntegrationWithRelations[]> {
		const conditions = [
			eq(IntegrationTable.organizationId, organizationId),
			eq(IntegrationTable.isActive, true),
		]
		if (type) conditions.push(eq(IntegrationTable.providerType, type))

		const integrations = await db
			.select()
			.from(IntegrationTable)
			.where(and(...conditions))
			.orderBy(desc(IntegrationTable.createdAt))

		return Promise.all(
			integrations.map((integration) => this.hydrateIntegration(integration)),
		)
	}

	/**
	 * Update integration configuration
	 * @param integrationId - Integration ID
	 * @param config - New configuration
	 * @returns Updated integration
	 */
	async updateIntegrationConfig(
		integrationId: string,
		config: Record<string, any>,
	): Promise<Integration> {
		const [existing] = await db
			.select({ providerName: IntegrationTable.providerName })
			.from(IntegrationTable)
			.where(eq(IntegrationTable.id, integrationId))
			.limit(1)

		if (existing?.providerName === 'jira') {
			const instanceUrl = config.instanceUrl ?? config.siteUrl
			if (instanceUrl !== undefined) {
				const jiraUrlPattern = /^https:\/\/[a-zA-Z0-9-]+\.atlassian\.net\/?$/
				if (
					typeof instanceUrl !== 'string' ||
					!jiraUrlPattern.test(instanceUrl)
				) {
					throw new Error(
						'Invalid Jira instance URL. Must be a valid Atlassian Cloud domain.',
					)
				}
			}
		}

		const [integration] = await db
			.update(IntegrationTable)
			.set({
				config: JSON.stringify(config),
				updatedAt: new Date(),
			})
			.where(eq(IntegrationTable.id, integrationId))
			.returning()

		if (!integration) {
			throw new Error('Integration not found')
		}
		await this.logIntegrationActivity(
			integrationId,
			'config_update',
			'success',
			{ config },
		)

		return integration
	}

	/**
	 * Disconnect an integration and all its connections
	 * @param integrationId - Integration ID to disconnect
	 */
	async disconnectIntegration(integrationId: string): Promise<void> {
		// Get integration details for logging
		const integration = await this.getIntegration(integrationId)
		if (!integration) {
			throw new Error('Integration not found')
		}

		// Delete all connections first
		await db
			.delete(ConnectionTable)
			.where(eq(ConnectionTable.integrationId, integrationId))

		// Delete integration logs
		await db
			.delete(IntegrationLogTable)
			.where(eq(IntegrationLogTable.integrationId, integrationId))

		// Delete the integration
		await db
			.delete(IntegrationTable)
			.where(eq(IntegrationTable.id, integrationId))

		// Log disconnection
		await this.logIntegrationActivity(integrationId, 'disconnect', 'success', {
			provider: integration.providerName,
			connectionCount: integration.connections?.length || 0,
		})
	}

	// Note-to-Channel Connection Management

	/**
	 * Connect a note to a channel
	 * @param params - Connection creation parameters
	 * @returns Created connection
	 */
	async connectNoteToChannel(
		params: CreateConnectionParams,
	): Promise<NoteIntegrationConnection> {
		const { noteId, integrationId, externalId, config = {} } = params

		// Validate integration exists and is active
		const integration = await this.getIntegration(integrationId)
		if (!integration || !integration.isActive) {
			throw new Error('Integration not found or inactive')
		}

		// Validate note exists and belongs to same organization
		const [note] = await db
			.select()
			.from(NoteTable)
			.where(eq(NoteTable.id, noteId))
			.limit(1)

		if (!note) {
			throw new Error('Note not found')
		}

		if (note.organizationId !== integration.organizationId) {
			throw new Error(
				'Note and integration must belong to the same organization',
			)
		}

		// Validate channel exists and is accessible
		const provider = this.getProvider(integration.providerName)
		const channels = await provider.getAvailableChannels(integration)
		const channel = channels.find((c) => c.id === externalId)

		if (!channel) {
			throw new Error('Channel not found or not accessible')
		}

		// Create connection
		const [connection] = await db
			.insert(ConnectionTable)
			.values({
				noteId,
				integrationId,
				externalId,
				config: JSON.stringify({
					...config,
					channelName: channel.name,
					channelType: channel.type,
					channelMetadata: channel.metadata || {},
				}),
				isActive: true,
			})
			.returning()

		if (!connection) {
			throw new Error('Failed to create connection')
		}
		// Log connection creation
		await this.logIntegrationActivity(
			integrationId,
			'connection_create',
			'success',
			{
				noteId,
				channelId: externalId,
				channelName: channel.name,
			},
		)

		return connection
	}

	/**
	 * Disconnect a note from a channel
	 * @param connectionId - Connection ID to remove
	 */
	async disconnectNoteFromChannel(connectionId: string): Promise<void> {
		const [connection] = await db
			.select()
			.from(ConnectionTable)
			.where(eq(ConnectionTable.id, connectionId))
			.limit(1)

		if (!connection) {
			throw new Error('Connection not found')
		}

		// Delete the connection
		await db.delete(ConnectionTable).where(eq(ConnectionTable.id, connectionId))

		// Log disconnection
		await this.logIntegrationActivity(
			connection.integrationId,
			'connection_delete',
			'success',
			{
				noteId: connection.noteId,
				channelId: connection.externalId,
			},
		)
	}

	/**
	 * Get all connections for a note
	 * @param noteId - Note ID
	 * @returns List of connections with integration details
	 */
	async getNoteConnections(noteId: string): Promise<ConnectionWithRelations[]> {
		const connections = await db
			.select()
			.from(ConnectionTable)
			.where(
				and(
					eq(ConnectionTable.noteId, noteId),
					eq(ConnectionTable.isActive, true),
				),
			)
			.orderBy(desc(ConnectionTable.createdAt))

		return Promise.all(
			connections.map((connection) => this.hydrateConnection(connection)),
		)
	}

	/**
	 * Get all connections for an integration
	 * @param integrationId - Integration ID
	 * @returns List of connections
	 */
	async getIntegrationConnections(
		integrationId: string,
	): Promise<ConnectionWithRelations[]> {
		const connections = await db
			.select()
			.from(ConnectionTable)
			.where(
				and(
					eq(ConnectionTable.integrationId, integrationId),
					eq(ConnectionTable.isActive, true),
				),
			)
			.orderBy(desc(ConnectionTable.createdAt))

		return Promise.all(
			connections.map((connection) => this.hydrateConnection(connection)),
		)
	}

	// Channel and Provider Operations

	/**
	 * Get available channels for an integration
	 * @param integrationId - Integration ID
	 * @returns Available channels
	 */
	async getAvailableChannels(integrationId: string): Promise<Channel[]> {
		const integration = await this.getIntegration(integrationId)
		if (!integration || !integration.isActive) {
			throw new Error('Integration not found or inactive')
		}

		const provider = this.getProvider(integration.providerName)

		try {
			const channels = await provider.getAvailableChannels(integration)

			// Log successful channel fetch
			await this.logIntegrationActivity(
				integrationId,
				'fetch_channels',
				'success',
				{ channelCount: channels.length },
			)

			return channels
		} catch (error) {
			// Log error
			await this.logIntegrationActivity(
				integrationId,
				'fetch_channels',
				'error',
				undefined,
				error instanceof Error ? error.message : 'Unknown error',
			)
			throw error
		}
	}

	// Message Posting and Notifications

	// Token Management

	/**
	 * Refresh expired tokens for an integration
	 * @param integrationId - Integration ID
	 * @returns Updated integration with new tokens
	 */
	async refreshIntegrationTokens(integrationId: string): Promise<Integration> {
		const integration = await this.getIntegration(integrationId)
		if (!integration) {
			throw new Error('Integration not found')
		}

		if (!integration.refreshToken) {
			throw new Error('No refresh token available')
		}

		const { tokenManager } = await import('./token-manager')
		const provider = this.getProvider(integration.providerName)
		const { decryptToken } = await import('./encryption')
		const refreshToken = await decryptToken(integration.refreshToken)

		const result = await tokenManager.refreshToken(
			integration,
			provider,
			refreshToken,
		)

		if (!result.success) {
			throw new Error(result.error || 'Token refresh failed')
		}

		const updated = await this.getIntegration(integrationId)
		if (!updated) {
			throw new Error('Failed to retrieve updated integration')
		}
		return updated
	}

	// Validation and Health Checks

	/**
	 * Validate all connections for an integration
	 * @param integrationId - Integration ID
	 * @returns Validation results
	 */
	async validateIntegrationConnections(integrationId: string): Promise<{
		valid: number
		invalid: number
		errors: string[]
	}> {
		const connections = await this.getIntegrationConnections(integrationId)
		const errors: string[] = []
		let valid = 0
		let invalid = 0

		if (connections.length === 0) {
			return { valid: 0, invalid: 0, errors: ['No connections found'] }
		}

		const provider = this.getProvider(
			connections[0]?.integration?.providerName as string,
		)
		if (!provider) {
			return {
				valid: 0,
				invalid: connections.length,
				errors: ['Provider not found'],
			}
		}

		// Validate each connection
		for (const connection of connections) {
			try {
				const isValid = await provider.validateConnection(connection)
				if (isValid) {
					valid++
				} else {
					invalid++
					errors.push(`Connection ${connection.id} is invalid`)
				}
			} catch (error) {
				invalid++
				const errorMsg =
					error instanceof Error ? error.message : 'Unknown error'
				errors.push(`Connection ${connection.id}: ${errorMsg}`)
			}
		}

		// Log validation results
		await this.logIntegrationActivity(
			integrationId,
			'validate_connections',
			errors.length > 0 ? 'error' : 'success',
			{ valid, invalid, totalConnections: connections.length },
		)

		return { valid, invalid, errors }
	}

	/**
	 * Get integration status and health
	 * @param integrationId - Integration ID
	 * @returns Integration status information
	 */
	async getIntegrationStatus(integrationId: string): Promise<{
		status: IntegrationStatus
		lastSync?: Date
		connectionCount: number
		recentErrors: IntegrationLogEntry[]
	}> {
		const integration = await this.getIntegration(integrationId)
		if (!integration) {
			throw new Error('Integration not found')
		}

		// Get recent error logs
		const recentErrors = await db
			.select()
			.from(IntegrationLogTable)
			.where(
				and(
					eq(IntegrationLogTable.integrationId, integrationId),
					eq(IntegrationLogTable.status, 'error'),
					gte(
						IntegrationLogTable.createdAt,
						new Date(Date.now() - 24 * 60 * 60 * 1000),
					),
				),
			)
			.orderBy(desc(IntegrationLogTable.createdAt))
			.limit(10)

		// Determine status
		let status: IntegrationStatus = 'active'

		if (!integration.isActive) {
			status = 'inactive'
		} else if (recentErrors.length > 5) {
			status = 'error'
		} else if (
			integration.tokenExpiresAt &&
			integration.tokenExpiresAt < new Date()
		) {
			status = 'expired'
		}

		return {
			status,
			lastSync: integration.lastSyncAt || undefined,
			connectionCount: integration.connections?.length || 0,
			recentErrors: recentErrors.map((log: any) => ({
				action: log.action,
				status: log.status as 'success' | 'error' | 'pending',
				requestData: log.requestData
					? this.safeJsonParse(log.requestData)
					: undefined,
				responseData: log.responseData
					? this.safeJsonParse(log.responseData)
					: undefined,
				errorMessage: log.errorMessage || undefined,
				timestamp: log.createdAt,
			})),
		}
	}

	/**
	 * Get integration statistics
	 * @param integrationId - Integration ID
	 * @returns Integration statistics
	 */
	async getIntegrationStats(integrationId: string): Promise<IntegrationStats> {
		const connections = await this.getIntegrationConnections(integrationId)
		const activeConnections = connections.filter((c) => c.isActive).length

		// Get recent activity (last 7 days)
		const [recentActivityResult] = await db
			.select({ value: count() })
			.from(IntegrationLogTable)
			.where(
				and(
					eq(IntegrationLogTable.integrationId, integrationId),
					gte(
						IntegrationLogTable.createdAt,
						new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
					),
				),
			)

		// Get error count (last 24 hours)
		const [errorCountResult] = await db
			.select({ value: count() })
			.from(IntegrationLogTable)
			.where(
				and(
					eq(IntegrationLogTable.integrationId, integrationId),
					eq(IntegrationLogTable.status, 'error'),
					gte(
						IntegrationLogTable.createdAt,
						new Date(Date.now() - 24 * 60 * 60 * 1000),
					),
				),
			)

		// Get last activity
		const [lastActivity] = await db
			.select({ createdAt: IntegrationLogTable.createdAt })
			.from(IntegrationLogTable)
			.where(eq(IntegrationLogTable.integrationId, integrationId))
			.orderBy(desc(IntegrationLogTable.createdAt))
			.limit(1)

		return {
			totalConnections: connections.length,
			activeConnections,
			recentActivity: recentActivityResult?.value ?? 0,
			lastActivity: lastActivity?.createdAt,
			errorCount: errorCountResult?.value ?? 0,
		}
	}

	// Logging and Monitoring

	/**
	 * Log integration activity
	 * @param integrationId - Integration ID
	 * @param action - Action performed
	 * @param status - Action status
	 * @param data - Additional data
	 * @param error - Error message if applicable
	 */
	async logIntegrationActivity(
		integrationId: string,
		action: string,
		status: 'success' | 'error' | 'pending',
		data?: Record<string, any>,
		error?: string,
	): Promise<void> {
		try {
			await db.insert(IntegrationLogTable).values({
				integrationId,
				action,
				status,
				requestData: data ? JSON.stringify(data) : null,
				errorMessage: error,
				createdAt: new Date(),
			})
		} catch (logError) {
			// Don't throw on logging errors to avoid breaking main functionality
			console.error('Failed to log integration activity:', logError)
		}
	}

	// Utility Methods

	/**
	 * Truncate content to a reasonable length for external posting
	 * @param content - Original content
	 * @param maxLength - Maximum length (default 500)
	 * @returns Truncated content
	 */
	private truncateContent(content: string, maxLength: number = 500): string {
		if (content.length <= maxLength) {
			return content
		}

		return content.substring(0, maxLength - 3) + '...'
	}

	/**
	 * Generate URL for a note
	 * @param note - Note data
	 * @returns Note URL
	 */
	private generateNoteUrl(note: OrganizationNote): string {
		const baseUrl = ENV.BASE_URL
		if (!baseUrl) {
			throw new Error('BASE_URL environment variable is required')
		}
		return `${baseUrl}/app/notes/${note.id}`
	}

	/**
	 * Safely parse JSON string, returning undefined if parsing fails
	 * @param jsonString - JSON string to parse
	 * @returns Parsed object or undefined
	 */
	private safeJsonParse(jsonString: string): Record<string, any> | undefined {
		try {
			return JSON.parse(jsonString) as Record<string, any>
		} catch {
			return undefined
		}
	}

	private async hydrateIntegration(
		integration: Integration,
	): Promise<IntegrationWithRelations> {
		const [organization] = await db
			.select()
			.from(OrganizationTable)
			.where(eq(OrganizationTable.id, integration.organizationId))
			.limit(1)
		const connections = await db
			.select()
			.from(ConnectionTable)
			.where(eq(ConnectionTable.integrationId, integration.id))
			.orderBy(desc(ConnectionTable.createdAt))

		const noteIds = Array.from(
			new Set(connections.map((c) => c.noteId).filter(Boolean)),
		)
		const notes =
			noteIds.length > 0
				? await db
						.select()
						.from(NoteTable)
						.where(inArray(NoteTable.id, noteIds))
				: []
		const notesMap = new Map(notes.map((n) => [n.id, n]))

		return {
			...integration,
			organization,
			connections: connections.map((connection) => ({
				...connection,
				note: notesMap.get(connection.noteId),
			})),
		}
	}

	private async hydrateConnection(
		connection: NoteIntegrationConnection,
	): Promise<ConnectionWithRelations> {
		const [[integration], [note]] = await Promise.all([
			db
				.select()
				.from(IntegrationTable)
				.where(eq(IntegrationTable.id, connection.integrationId))
				.limit(1),
			db
				.select()
				.from(NoteTable)
				.where(eq(NoteTable.id, connection.noteId))
				.limit(1),
		])

		if (!integration) {
			throw new Error('Integration not found for connection')
		}

		return { ...connection, integration, note }
	}
}

// Export singleton instance
export const integrationManager = IntegrationManager.getInstance()
