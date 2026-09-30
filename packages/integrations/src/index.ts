/**
 * Core integration system exports
 *
 * This module provides the foundational types, interfaces, and services
 * for the third-party integration system.
 */

// Core types
export type {
	TokenData,
	Channel,
	MessageData,
	SlackConfig,
	TeamsConfig,
	SlackConnectionConfig,
	ProviderConfig,
	ConnectionConfig,
	OAuthCallbackParams,
	OAuthState,
	IntegrationStatus,
	ProviderType,
	IntegrationLogEntry,
} from './types'

// Provider interfaces and base classes
export {
	type IntegrationProvider,
	BaseIntegrationProvider,
	ProviderRegistry,
	providerRegistry,
} from './provider'

// Message formatting
export {
	type MessageFormatter,
	BaseMessageFormatter,
	formatNoteMessage,
	truncateContent,
	generateNoteUrl,
} from './message-formatting'

export {
	IntegrationManager,
	integrationManager,
	type IntegrationWithRelations,
	type ConnectionWithRelations,
	type CreateIntegrationParams,
	type CreateConnectionParams,
	type IntegrationStats,
} from './integration-manager'

// Encryption and security utilities
export {
	IntegrationEncryptionService,
	integrationEncryption,
	isEncryptionConfigured,
	generateNewEncryptionKey,
	type EncryptedTokenData,
	type TokenValidationResult,
} from './encryption'

export {
	TokenManager,
	tokenManager,
	type TokenRefreshResult,
	type TokenStorageResult,
} from './token-manager'

// OAuth flow management
export { OAuthStateManager, OAuthCallbackHandler } from './oauth-manager'
export { oauthFlow } from './oauth-flow'
export {
	readOAuthAuthorizationCode,
	readOAuthStateFromRequest,
	peekOAuthState,
	needsCloverAuthorizeStep,
	integrationOAuthCallbackUrl,
} from './oauth-callback-params.ts'

// Note notification system
export {
	NoteNotifier,
	noteNotifier,
	type NoteChangeType,
	type NoteChangeEvent,
	type NoteEventResult,
} from './note-notifier'

export {
	NoteHooks,
	noteHooks,
	triggerNoteCreated,
	triggerNoteUpdated,
	triggerNoteDeleted,
	NoteOperationWrapper,
} from './note-hooks'

export * from './providers'
export {
	listGoogleBusinessLocations,
	importGoogleBusinessLocation,
} from './providers/google-business-profile/service'

export {
	assertLocationInOrganization,
	ensureDefaultOrganizationLocation,
	findScopedIntegration,
	getDefaultOrganizationLocationId,
	requireLocationIdForProvider,
	resolveOrganizationLocationIdForConnect,
} from './location-integrations.ts'
export { isLocationScopedIntegration } from './integration-scope.ts'

// POS and delivery-platform integrations (Clover, Square, Toast, Uber Eats, DoorDash)
export * from './pos'

export type {
	Integration,
	NoteIntegrationConnection,
	OrganizationNote,
} from '@repo/database/types'

// Route handlers
export {
	handleOAuthCallback,
	handleJiraSearchUsers,
	handleJiraCurrentUser,
	handleUpdateIntegrationConfig,
	type OAuthCallbackDependencies,
	type JiraSearchUsersDependencies,
	type JiraCurrentUserDependencies,
	type UpdateConfigDependencies,
} from './route-handlers'
