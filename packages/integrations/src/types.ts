/**
 * Core integration types and interfaces for third-party service integrations
 */

// Token data structure for OAuth and API key authentication
export interface TokenData {
	accessToken: string
	refreshToken?: string
	expiresAt?: Date
	scope?: string
	metadata?: Record<string, any>
}

// Channel representation for messaging services
export interface Channel {
	id: string
	name: string
	type: 'public' | 'private' | 'dm'
	metadata?: Record<string, any>
}

// Message data structure for posting to external services
export interface MessageData {
	title: string
	content: string
	author: string
	noteUrl: string
	changeType: 'created' | 'updated' | 'deleted'
}

// Provider-specific configuration types
export interface SlackConfig {
	teamId: string
	teamName: string
	botUserId: string
	scope: string
}

export interface TeamsConfig {
	tenantId: string
	teamId?: string
	scope: string
}

export interface JiraConfig {
	instanceUrl: string
	cloudId: string
	scope: string
	user: {
		accountId: string
		displayName: string
		emailAddress?: string
	}
	// Bot user configuration
	useBotUser?: boolean
	botUser?: {
		accountId: string
		displayName: string
		emailAddress?: string
	}
}

export interface LinearConfig {
	userId: string
	userName: string
	userEmail: string
	scope: string
}

export interface GitLabConfig {
	instanceUrl: string
	scope: string
	user: {
		id: number
		username: string
		name: string
		email?: string
		avatarUrl?: string
	}
}

export interface ClickUpConfig {
	scope?: string
	user: {
		id: number
		username: string
		email: string
		profilePicture?: string
		initials: string
		timezone: string
	}
}

export interface NotionConfig {
	workspaceId: string
	workspaceName: string
	botId: string
	user: {
		id: string
		name: string
		email?: string
		avatarUrl?: string
	}
}

export interface AsanaConfig {
	user: {
		gid: string
		name: string
		email?: string
		photo?: {
			image_21x21?: string
			image_27x27?: string
			image_36x36?: string
			image_60x60?: string
		}
	}
	workspaces: Array<{
		gid: string
		name: string
		resource_type: string
	}>
}

// Connection-specific configuration
export interface SlackConnectionConfig {
	channelName: string
	channelType: 'public' | 'private'
	postFormat: 'blocks' | 'text'
	includeContent: boolean
}

export interface JiraConnectionConfig {
	projectKey: string
	projectName: string
	defaultIssueType: string
	includeNoteContent: boolean
	// Bot user settings for this connection
	useBotUser?: boolean
	reporterAccountId?: string // Override the issue reporter
}

export interface LinearConnectionConfig {
	channelId: string
	channelName: string
	channelType: 'team' | 'project'
	includeNoteContent: boolean
	defaultIssueState?: string
	issuePriority?: string
}

export interface GitLabConnectionConfig {
	projectId: string
	projectName: string
	projectPath: string
	includeNoteContent: boolean
	defaultLabels?: string[]
	milestoneId?: number
	assigneeId?: number
}

export interface ClickUpConnectionConfig {
	listId: string
	listName: string
	spaceName: string
	teamName: string
	includeNoteContent: boolean
	defaultPriority?: number // 1=Urgent, 2=High, 3=Normal, 4=Low
	defaultAssignees?: number[]
	defaultTags?: string[]
	defaultStatus?: string
}

export interface NotionConnectionConfig {
	databaseId: string
	databaseName: string
	includeNoteContent: boolean
	defaultProperties?: Record<string, any>
}

export interface AsanaConnectionConfig {
	projectGid: string
	projectName: string
	workspaceName: string
	includeNoteContent: boolean
	defaultAssignee?: string // User GID to assign tasks to by default
	defaultSection?: string // Section GID to add tasks to
}

export interface TrelloConfig {
	user: {
		id: string
		username: string
		fullName: string
		email?: string
		avatarUrl?: string
	}
	boards: Array<{
		id: string
		name: string
		url: string
	}>
}

export interface TrelloConnectionConfig {
	listId: string
	listName: string
	boardName: string
	includeNoteContent: boolean
	defaultLabels?: string[] // Array of label IDs to apply to created cards
	defaultMembers?: string[] // Array of member IDs to assign cards to by default
}

export interface GitHubConfig {
	user: {
		id: number
		login: string
		name?: string
		email?: string
		avatarUrl?: string
	}
	scope: string
}

export interface GitHubConnectionConfig {
	repositoryId: string
	repositoryName: string
	repositoryFullName: string
	ownerName: string
	includeNoteContent: boolean
	defaultLabels?: string[] // Array of label names to apply to created issues
	defaultAssignees?: string[] // Array of usernames to assign issues to by default
	defaultMilestone?: number // Milestone number for created issues
}

// Generic provider configuration
export type ProviderConfig =
	| SlackConfig
	| TeamsConfig
	| JiraConfig
	| LinearConfig
	| GitLabConfig
	| ClickUpConfig
	| NotionConfig
	| AsanaConfig
	| TrelloConfig
	| GitHubConfig
	| Record<string, any>

// Generic connection configuration
export type ConnectionConfig =
	| SlackConnectionConfig
	| JiraConnectionConfig
	| LinearConnectionConfig
	| GitLabConnectionConfig
	| ClickUpConnectionConfig
	| NotionConnectionConfig
	| AsanaConnectionConfig
	| TrelloConnectionConfig
	| GitHubConnectionConfig
	| Record<string, any>

// OAuth callback parameters
export interface OAuthCallbackParams {
	organizationId: string
	code: string
	state: string
	error?: string
	errorDescription?: string
	oauthToken?: string
	oauthVerifier?: string
	/** Merchant/store id some providers include on the callback URL (e.g. Clover). */
	merchantId?: string
	/** Registered OAuth callback URL (required by some token exchanges). */
	redirectUri?: string
}

// OAuth state data
export interface OAuthState {
	organizationId: string
	providerName: string
	/** Menuza location for POS and Google Business Profile OAuth. */
	organizationLocationId?: string
	redirectUrl?: string
	/** OAuth redirect URI registered with the provider (token exchange). */
	oauthRedirectUri?: string
	timestamp: number
	nonce?: string
	[key: string]: any
}

// Integration status types
export type IntegrationStatus = 'active' | 'inactive' | 'error' | 'expired'

// Integration provider types. `pos`/`delivery` are restaurant POS and delivery
// marketplace platforms (see `./pos`).
export type ProviderType =
	| 'productivity'
	| 'ticketing'
	| 'communication'
	| 'pos'
	| 'delivery'
	| 'business-profile'

// Integration log entry
export interface IntegrationLogEntry {
	action: string
	status: 'success' | 'error' | 'pending'
	requestData?: Record<string, any>
	responseData?: Record<string, any>
	errorMessage?: string
	timestamp: Date
}

// Integration provider interface
export interface IntegrationProvider {
	name: string
	type: ProviderType

	// OAuth flow methods
	getAuthUrl(organizationId: string, redirectUri: string): Promise<string>
	handleCallback(code: string, state: string): Promise<TokenData>
	refreshToken?(refreshToken: string): Promise<TokenData>
	revokeToken?(accessToken: string): Promise<void>

	// Provider-specific operations
	getAvailableChannels(accessToken: string): Promise<Channel[]>
	postMessage(
		accessToken: string,
		channelId: string,
		message: MessageData,
	): Promise<void>
	validateConnection(accessToken: string, channelId: string): Promise<boolean>
}
