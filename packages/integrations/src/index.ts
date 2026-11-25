/**
 * Core integration system exports
 *
 * This module provides the foundational types, interfaces, and services
 * for the third-party integration system.
 */

import './providers/index'

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
	pruneOldIntegrationLogs,
	type IntegrationWithRelations,
	type ConnectionWithRelations,
	type CreateIntegrationParams,
	type CreateConnectionParams,
	type IntegrationStats,
} from './integration-manager'

export {
	DEFAULT_RAW_RESPONSE_MAX_CHARS,
	redactSecrets,
	redactSecretsInText,
	toSafeSyncErrorMessage,
	trimRawResponse,
} from './redact.ts'

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
	SEARCH_CONSOLE_PROVIDER,
	SEARCH_CONSOLE_SCOPES,
	isSearchConsoleMockMode,
} from './providers/google-search-console/provider'
export {
	listGoogleBusinessLocations,
	importGoogleBusinessLocation,
	listGoogleBusinessReviews,
	replyToGoogleBusinessReview,
	type GoogleBusinessReview,
	type GoogleReviewPageTokens,
	googleBusinessSchedule,
	googleAddressToMenuza,
	resolveGbpAccountName,
	mockGoogleLocationName,
} from './providers/google-business-profile/service'
export { isGoogleBusinessProfileMockMode } from './providers/google-business-profile/provider'
export {
	gbpClientFor,
	googleGbpClient,
	setGbpClientFactory,
	GBP_LISTING_READ_MASK,
	type AttributeValues,
	type DailyMetricSeries,
	type FoodMenusBody,
	type GbpClient,
	type GbpListing,
	type GbpMediaItem,
	type LocalPost,
	type LocalPostBody,
	type PatchOutcome,
	type PlaceActionLink,
	type SearchKeywordCount,
	type VerificationRecord,
	type VoiceOfMerchantState,
} from './providers/google-business-profile/client'
export {
	gbpMockCalls,
	mockGbpClient,
	readGbpMockState,
	resetGbpMock,
	setGbpMockState,
	MOCK_METRICS_LAG_DAYS,
	MOCK_VERIFICATION_CODE,
} from './providers/google-business-profile/mock-client'
export {
	claimGoogleLocation,
	releaseGoogleLocation,
	type GbpLinkInput,
} from './providers/google-business-profile/link'

export {
	listYelpLocations,
	importYelpLocation,
	listYelpReviews,
	replyToYelpReview,
	type YelpBusinessLocation,
	type YelpReview,
	type YelpReviewPageTokens,
} from './providers/yelp/service'

export {
	listTripAdvisorLocations,
	importTripAdvisorLocation,
	listTripAdvisorReviews,
	replyToTripAdvisorReview,
	type TripAdvisorLocation,
	type TripAdvisorReview,
	type TripAdvisorReviewPageTokens,
} from './providers/tripadvisor/service'

export {
	listDeliverooLocations,
	importDeliverooLocation,
	listDeliverooReviews,
	replyToDeliverooReview,
	type DeliverooLocation,
	type DeliverooReview,
	type DeliverooReviewPageTokens,
} from './providers/deliveroo/service'

export {
	listJustEatLocations,
	importJustEatLocation,
	listJustEatReviews,
	replyToJustEatReview,
	type JustEatLocation,
	type JustEatReview,
	type JustEatReviewPageTokens,
} from './providers/just-eat/service'

export {
	listOpenTableLocations,
	importOpenTableLocation,
	listOpenTableReviews,
	replyToOpenTableReview,
	type OpenTableLocation,
	type OpenTableReview,
	type OpenTableReviewPageTokens,
} from './providers/opentable/service'

export {
	listResyVenues,
	importResyVenue,
	listResyReviews,
	replyToResyReview,
	type ResyVenue,
	type ResyReview,
	type ResyReviewPageTokens,
} from './providers/resy/service'

export {
	listUnifiedReviews,
	replyToUnifiedReview,
	getAvailableReviewProviders,
	type UnifiedReview,
	type UnifiedReviewPageTokens,
	type ReviewProviderDisplayInfo,
} from './providers/unified-reviews'

export {
	assertLocationInOrganization,
	ensureDefaultOrganizationLocation,
	findScopedIntegration,
	getDefaultOrganizationLocationId,
	requireLocationIdForProvider,
	resolveOrganizationLocationIdForConnect,
} from './location-integrations.ts'
export {
	isLocationScopedIntegration,
	isReviewProvider,
	REVIEW_PROVIDER_NAMES,
	type ReviewProviderName,
} from './integration-scope.ts'

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
