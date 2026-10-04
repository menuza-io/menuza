/**
 * Comprehensive audit action types for the entire application
 * Following enterprise best practices for audit logging
 */
export enum AuditAction {
	// Authentication & Authorization
	USER_LOGIN = 'user_login',
	USER_LOGOUT = 'user_logout',
	USER_LOGIN_FAILED = 'user_login_failed',
	PASSWORD_RESET_REQUESTED = 'password_reset_requested',
	PASSWORD_RESET_COMPLETED = 'password_reset_completed',
	PASSWORD_CHANGED = 'password_changed',
	TWO_FACTOR_ENABLED = 'two_factor_enabled',
	TWO_FACTOR_DISABLED = 'two_factor_disabled',
	SESSION_CREATED = 'session_created',
	SESSION_REFRESHED = 'session_refreshed',
	SESSION_EXPIRED = 'session_expired',
	SESSION_REVOKED = 'session_revoked',

	// User Management
	USER_CREATED = 'user_created',
	USER_UPDATED = 'user_updated',
	USER_DELETED = 'user_deleted',
	USER_SUSPENDED = 'user_suspended',
	USER_UNSUSPENDED = 'user_unsuspended',
	USER_BANNED = 'user_banned',
	USER_UNBANNED = 'user_unbanned',
	USER_EMAIL_VERIFIED = 'user_email_verified',
	USER_PROFILE_UPDATED = 'user_profile_updated',
	USER_ACTIVATED = 'user_activated',
	USER_DEACTIVATED = 'user_deactivated',

	// Role & Permission Management
	USER_ROLE_ASSIGNED = 'user_role_assigned',
	USER_ROLE_REMOVED = 'user_role_removed',
	USER_PERMISSION_GRANTED = 'user_permission_granted',
	USER_PERMISSION_REVOKED = 'user_permission_revoked',
	USER_PERMISSIONS_UPDATED = 'user_permissions_updated',
	ROLE_CREATED = 'role_created',
	ROLE_UPDATED = 'role_updated',
	ROLE_DELETED = 'role_deleted',

	// Organization Management
	ORG_CREATED = 'org_created',
	ORG_UPDATED = 'org_updated',
	ORG_DELETED = 'org_deleted',
	ORG_SETTINGS_UPDATED = 'org_settings_updated',
	ORG_MEMBER_ADDED = 'org_member_added',
	ORG_MEMBER_REMOVED = 'org_member_removed',
	ORG_MEMBER_ROLE_CHANGED = 'org_member_role_changed',
	ORG_INVITATION_SENT = 'org_invitation_sent',
	ORG_INVITATION_ACCEPTED = 'org_invitation_accepted',
	ORG_INVITATION_REVOKED = 'org_invitation_revoked',
	ORG_INVITE_LINK_CREATED = 'org_invite_link_created',
	ORG_INVITE_LINK_DISABLED = 'org_invite_link_disabled',

	// Data Operations - Notes
	NOTE_CREATED = 'note_created',
	NOTE_VIEWED = 'note_viewed',
	NOTE_UPDATED = 'note_updated',
	NOTE_DELETED = 'note_deleted',
	NOTE_SHARED = 'note_shared',
	NOTE_UNSHARED = 'note_unshared',
	NOTE_FAVORITED = 'note_favorited',
	NOTE_UNFAVORITED = 'note_unfavorited',
	NOTE_COMMENT_ADDED = 'note_comment_added',
	NOTE_COMMENT_UPDATED = 'note_comment_updated',
	NOTE_COMMENT_DELETED = 'note_comment_deleted',

	// Team chat
	CHAT_CHANNEL_CREATED = 'chat_channel_created',
	CHAT_CHANNEL_UPDATED = 'chat_channel_updated',
	CHAT_CHANNEL_DELETED = 'chat_channel_deleted',
	CHAT_RETENTION_UPDATED = 'chat_retention_updated',
	NOTE_STATUS_CHANGED = 'note_status_changed',
	NOTE_PRIORITY_CHANGED = 'note_priority_changed',
	NOTE_ACCESS_GRANTED = 'note_access_granted',
	NOTE_ACCESS_REVOKED = 'note_access_revoked',

	// File Operations
	FILE_UPLOADED = 'file_uploaded',
	FILE_DOWNLOADED = 'file_downloaded',
	FILE_DELETED = 'file_deleted',
	BULK_FILE_UPLOAD = 'bulk_file_upload',
	BULK_FILE_DELETE = 'bulk_file_delete',

	// Integration Management
	INTEGRATION_CONNECTED = 'integration_connected',
	INTEGRATION_DISCONNECTED = 'integration_disconnected',
	INTEGRATION_CONFIGURED = 'integration_configured',
	INTEGRATION_SYNC_STARTED = 'integration_sync_started',
	INTEGRATION_SYNC_COMPLETED = 'integration_sync_completed',
	INTEGRATION_SYNC_FAILED = 'integration_sync_failed',

	// API & Security
	API_KEY_CREATED = 'api_key_created',
	API_KEY_USED = 'api_key_used',
	API_KEY_REVOKED = 'api_key_revoked',
	API_KEY_EXPIRED = 'api_key_expired',
	IP_BLACKLISTED = 'ip_blacklisted',
	IP_UNBLACKLISTED = 'ip_unblacklisted',
	SUSPICIOUS_ACTIVITY_DETECTED = 'suspicious_activity_detected',
	RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
	INVALID_REQUEST = 'invalid_request',
	SECURITY_VIOLATION = 'security_violation',
	SENSITIVE_ROUTE_ACCESSED = 'sensitive_route_accessed',

	// Admin Operations
	ADMIN_IMPERSONATION_START = 'admin_impersonation_start',
	ADMIN_IMPERSONATION_END = 'admin_impersonation_end',
	ADMIN_CONFIG_CHANGED = 'admin_config_changed',
	ADMIN_USER_SEARCH = 'admin_user_search',
	ADMIN_DATA_EXPORT = 'admin_data_export',

	// Subscription & Billing
	SUBSCRIPTION_CREATED = 'subscription_created',
	SUBSCRIPTION_UPDATED = 'subscription_updated',
	SUBSCRIPTION_CANCELLED = 'subscription_cancelled',
	SUBSCRIPTION_RENEWED = 'subscription_renewed',
	PAYMENT_METHOD_ADDED = 'payment_method_added',
	PAYMENT_METHOD_REMOVED = 'payment_method_removed',
	PAYMENT_SUCCEEDED = 'payment_succeeded',
	PAYMENT_FAILED = 'payment_failed',

	// SSO (Expanded)
	SSO_CONFIG_CREATED = 'sso_config_created',
	SSO_CONFIG_UPDATED = 'sso_config_updated',
	SSO_CONFIG_ENABLED = 'sso_config_enabled',
	SSO_CONFIG_DISABLED = 'sso_config_disabled',
	SSO_CONFIG_DELETED = 'sso_config_deleted',
	SSO_CONFIG_TESTED = 'sso_config_tested',
	SSO_CONFIG_WARNING = 'sso_config_warning',
	SSO_CONFIG_ERROR = 'sso_config_error',

	SSO_AUTH_INITIATED = 'sso_auth_initiated',
	SSO_LOGIN = 'sso_login', // Success
	SSO_LOGOUT = 'sso_logout',
	SSO_LOGIN_FAILED = 'sso_login_failed',
	SSO_AUTH_CALLBACK_RECEIVED = 'sso_auth_callback_received',
	SSO_AUTH_TOKEN_EXCHANGED = 'sso_auth_token_exchanged',

	SSO_USER_PROVISIONED = 'sso_user_provisioned',
	SSO_USER_ROLE_CHANGED = 'sso_user_role_changed',

	SSO_HEALTH_CHECK_FAILED = 'sso_health_check_failed',
	SSO_PROVIDER_UNAVAILABLE = 'sso_provider_unavailable',
	SSO_CONFIGURATION_ERROR = 'sso_configuration_error',
	SSO_VALIDATION_FAILED = 'sso_validation_failed',
	SSO_PERIODIC_VALIDATION = 'sso_periodic_validation',

	// MCP (Model Context Protocol) OAuth
	MCP_AUTHORIZATION_REQUESTED = 'mcp_authorization_requested',
	MCP_AUTHORIZATION_APPROVED = 'mcp_authorization_approved',
	MCP_AUTHORIZATION_DENIED = 'mcp_authorization_denied',
	MCP_AUTHORIZATION_REVOKED = 'mcp_authorization_revoked',
	MCP_TOKEN_ISSUED = 'mcp_token_issued',
	MCP_TOKEN_REFRESHED = 'mcp_token_refreshed',
	MCP_TOOL_INVOKED = 'mcp_tool_invoked',
	MCP_RATE_LIMIT_EXCEEDED = 'mcp_rate_limit_exceeded',

	// System Events
	SYSTEM_BACKUP_STARTED = 'system_backup_started',
	SYSTEM_BACKUP_COMPLETED = 'system_backup_completed',
	SYSTEM_RESTORE_STARTED = 'system_restore_started',
	SYSTEM_RESTORE_COMPLETED = 'system_restore_completed',
	SYSTEM_MAINTENANCE_START = 'system_maintenance_start',
	SYSTEM_MAINTENANCE_END = 'system_maintenance_end',

	// Data Privacy & Compliance
	DATA_EXPORT_REQUESTED = 'data_export_requested',
	DATA_EXPORT_COMPLETED = 'data_export_completed',
	DATA_EXPORT_FAILED = 'data_export_failed',
	DATA_DELETION_REQUESTED = 'data_deletion_requested',
	DATA_DELETION_COMPLETED = 'data_deletion_completed',
	DATA_DELETION_CANCELLED = 'data_deletion_cancelled',
	DATA_DELETION_FAILED = 'data_deletion_failed',
	GDPR_ACCESS_REQUEST = 'gdpr_access_request',
	AUDIT_LOG_EXPORTED = 'audit_log_exported',
	AUDIT_LOG_VIEWED = 'audit_log_viewed',
}
