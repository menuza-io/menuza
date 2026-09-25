/* eslint-disable */
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type * as schema from './schema.ts'

export type User = InferSelectModel<typeof schema.User>
export type UserInsert = InferInsertModel<typeof schema.User>
export type Note = InferSelectModel<typeof schema.Note>
export type NoteInsert = InferInsertModel<typeof schema.Note>
export type NoteImage = InferSelectModel<typeof schema.NoteImage>
export type NoteImageInsert = InferInsertModel<typeof schema.NoteImage>
export type UserImage = InferSelectModel<typeof schema.UserImage>
export type UserImageInsert = InferInsertModel<typeof schema.UserImage>
export type Password = InferSelectModel<typeof schema.Password>
export type PasswordInsert = InferInsertModel<typeof schema.Password>
export type Session = InferSelectModel<typeof schema.Session>
export type SessionInsert = InferInsertModel<typeof schema.Session>
export type RefreshToken = InferSelectModel<typeof schema.RefreshToken>
export type RefreshTokenInsert = InferInsertModel<typeof schema.RefreshToken>
export type Permission = InferSelectModel<typeof schema.Permission>
export type PermissionInsert = InferInsertModel<typeof schema.Permission>
export type Role = InferSelectModel<typeof schema.Role>
export type RoleInsert = InferInsertModel<typeof schema.Role>
export type Verification = InferSelectModel<typeof schema.Verification>
export type VerificationInsert = InferInsertModel<typeof schema.Verification>
export type Connection = InferSelectModel<typeof schema.Connection>
export type ConnectionInsert = InferInsertModel<typeof schema.Connection>
export type Passkey = InferSelectModel<typeof schema.Passkey>
export type PasskeyInsert = InferInsertModel<typeof schema.Passkey>
export type BackupCode = InferSelectModel<typeof schema.BackupCode>
export type BackupCodeInsert = InferInsertModel<typeof schema.BackupCode>
export type Organization = InferSelectModel<typeof schema.Organization>
export type OrganizationInsert = InferInsertModel<typeof schema.Organization>
export type OrganizationLocation = InferSelectModel<
	typeof schema.OrganizationLocation
>
export type OrganizationLocationInsert = InferInsertModel<
	typeof schema.OrganizationLocation
>
export type OrganizationAnnouncement = InferSelectModel<
	typeof schema.OrganizationAnnouncement
>
export type OrganizationAnnouncementInsert = InferInsertModel<
	typeof schema.OrganizationAnnouncement
>
export type OrganizationSiteAsset = InferSelectModel<
	typeof schema.OrganizationSiteAsset
>
export type OrganizationSiteAssetInsert = InferInsertModel<
	typeof schema.OrganizationSiteAsset
>
export type WebsitePage = InferSelectModel<typeof schema.WebsitePage>
export type WebsitePageInsert = InferInsertModel<typeof schema.WebsitePage>
export type WebsitePageSection = InferSelectModel<
	typeof schema.WebsitePageSection
>
export type WebsitePageSectionInsert = InferInsertModel<
	typeof schema.WebsitePageSection
>
export type OrganizationRole = InferSelectModel<typeof schema.OrganizationRole>
export type OrganizationRoleInsert = InferInsertModel<
	typeof schema.OrganizationRole
>
export type UserOrganization = InferSelectModel<typeof schema.UserOrganization>
export type UserOrganizationInsert = InferInsertModel<
	typeof schema.UserOrganization
>
export type OrganizationImage = InferSelectModel<
	typeof schema.OrganizationImage
>
export type OrganizationImageInsert = InferInsertModel<
	typeof schema.OrganizationImage
>
export type OrganizationS3Config = InferSelectModel<
	typeof schema.OrganizationS3Config
>
export type OrganizationS3ConfigInsert = InferInsertModel<
	typeof schema.OrganizationS3Config
>
export type OrganizationInvitation = InferSelectModel<
	typeof schema.OrganizationInvitation
>
export type OrganizationInvitationInsert = InferInsertModel<
	typeof schema.OrganizationInvitation
>
export type OrganizationInviteLink = InferSelectModel<
	typeof schema.OrganizationInviteLink
>
export type OrganizationInviteLinkInsert = InferInsertModel<
	typeof schema.OrganizationInviteLink
>
export type UtmSource = InferSelectModel<typeof schema.UtmSource>
export type UtmSourceInsert = InferInsertModel<typeof schema.UtmSource>
export type OrganizationNote = InferSelectModel<typeof schema.OrganizationNote>
export type OrganizationNoteInsert = InferInsertModel<
	typeof schema.OrganizationNote
>
export type OrganizationNoteUpload = InferSelectModel<
	typeof schema.OrganizationNoteUpload
>
export type OrganizationNoteUploadInsert = InferInsertModel<
	typeof schema.OrganizationNoteUpload
>
export type Integration = InferSelectModel<typeof schema.Integration>
export type IntegrationInsert = InferInsertModel<typeof schema.Integration>
export type NoteIntegrationConnection = InferSelectModel<
	typeof schema.NoteIntegrationConnection
>
export type NoteIntegrationConnectionInsert = InferInsertModel<
	typeof schema.NoteIntegrationConnection
>
export type IntegrationLog = InferSelectModel<typeof schema.IntegrationLog>
export type IntegrationLogInsert = InferInsertModel<
	typeof schema.IntegrationLog
>
export type NoteAccess = InferSelectModel<typeof schema.NoteAccess>
export type NoteAccessInsert = InferInsertModel<typeof schema.NoteAccess>
export type NoteComment = InferSelectModel<typeof schema.NoteComment>
export type NoteCommentInsert = InferInsertModel<typeof schema.NoteComment>
export type NoteCommentImage = InferSelectModel<typeof schema.NoteCommentImage>
export type NoteCommentImageInsert = InferInsertModel<
	typeof schema.NoteCommentImage
>
export type NoteActivityLog = InferSelectModel<typeof schema.NoteActivityLog>
export type NoteActivityLogInsert = InferInsertModel<
	typeof schema.NoteActivityLog
>
export type OnboardingStep = InferSelectModel<typeof schema.OnboardingStep>
export type OnboardingStepInsert = InferInsertModel<
	typeof schema.OnboardingStep
>
export type OnboardingStepProgress = InferSelectModel<
	typeof schema.OnboardingStepProgress
>
export type OnboardingStepProgressInsert = InferInsertModel<
	typeof schema.OnboardingStepProgress
>
export type OnboardingProgress = InferSelectModel<
	typeof schema.OnboardingProgress
>
export type OnboardingProgressInsert = InferInsertModel<
	typeof schema.OnboardingProgress
>
export type OrganizationNoteFavorite = InferSelectModel<
	typeof schema.OrganizationNoteFavorite
>
export type OrganizationNoteFavoriteInsert = InferInsertModel<
	typeof schema.OrganizationNoteFavorite
>
export type OrganizationNoteStatus = InferSelectModel<
	typeof schema.OrganizationNoteStatus
>
export type OrganizationNoteStatusInsert = InferInsertModel<
	typeof schema.OrganizationNoteStatus
>
export type Feedback = InferSelectModel<typeof schema.Feedback>
export type FeedbackInsert = InferInsertModel<typeof schema.Feedback>
export type IpAddress = InferSelectModel<typeof schema.IpAddress>
export type IpAddressInsert = InferInsertModel<typeof schema.IpAddress>
export type IpAddressUser = InferSelectModel<typeof schema.IpAddressUser>
export type IpAddressUserInsert = InferInsertModel<typeof schema.IpAddressUser>
export type ApiKey = InferSelectModel<typeof schema.ApiKey>
export type ApiKeyInsert = InferInsertModel<typeof schema.ApiKey>
export type ConfigFlag = InferSelectModel<typeof schema.ConfigFlag>
export type ConfigFlagInsert = InferInsertModel<typeof schema.ConfigFlag>
export type SSOConfiguration = InferSelectModel<typeof schema.SSOConfiguration>
export type SSOConfigurationInsert = InferInsertModel<
	typeof schema.SSOConfiguration
>
export type SSOSession = InferSelectModel<typeof schema.SSOSession>
export type SSOSessionInsert = InferInsertModel<typeof schema.SSOSession>
export type AuditLog = InferSelectModel<typeof schema.AuditLog>
export type AuditLogInsert = InferInsertModel<typeof schema.AuditLog>
export type AuditLogRetentionPolicy = InferSelectModel<
	typeof schema.AuditLogRetentionPolicy
>
export type AuditLogRetentionPolicyInsert = InferInsertModel<
	typeof schema.AuditLogRetentionPolicy
>
export type WaitlistEntry = InferSelectModel<typeof schema.WaitlistEntry>
export type WaitlistEntryInsert = InferInsertModel<typeof schema.WaitlistEntry>
export type MCPClient = InferSelectModel<typeof schema.MCPClient>
export type MCPClientInsert = InferInsertModel<typeof schema.MCPClient>
export type MCPAuthorization = InferSelectModel<typeof schema.MCPAuthorization>
export type MCPAuthorizationInsert = InferInsertModel<
	typeof schema.MCPAuthorization
>
export type MCPAccessToken = InferSelectModel<typeof schema.MCPAccessToken>
export type MCPAccessTokenInsert = InferInsertModel<
	typeof schema.MCPAccessToken
>
export type MCPRefreshToken = InferSelectModel<typeof schema.MCPRefreshToken>
export type MCPRefreshTokenInsert = InferInsertModel<
	typeof schema.MCPRefreshToken
>
export type RateLimitEntry = InferSelectModel<typeof schema.RateLimitEntry>
export type RateLimitEntryInsert = InferInsertModel<
	typeof schema.RateLimitEntry
>
export type ImpersonationSession = InferSelectModel<
	typeof schema.ImpersonationSession
>
export type ImpersonationSessionInsert = InferInsertModel<
	typeof schema.ImpersonationSession
>
export type DataSubjectRequest = InferSelectModel<
	typeof schema.DataSubjectRequest
>
export type DataSubjectRequestInsert = InferInsertModel<
	typeof schema.DataSubjectRequest
>
export type Notification = InferSelectModel<typeof schema.Notification>
export type NotificationInsert = InferInsertModel<typeof schema.Notification>
export type NotificationPreference = InferSelectModel<
	typeof schema.NotificationPreference
>
export type NotificationPreferenceInsert = InferInsertModel<
	typeof schema.NotificationPreference
>
export type SavedReport = InferSelectModel<typeof schema.SavedReport>
export type SavedReportInsert = InferInsertModel<typeof schema.SavedReport>

export const ConfigFlagLevel = {
	system: 'system',
	organization: 'organization',
	user: 'user',
} as const
export type ConfigFlagLevel =
	(typeof ConfigFlagLevel)[keyof typeof ConfigFlagLevel]
