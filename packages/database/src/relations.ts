import { relations } from 'drizzle-orm'
import {
	User,
	Note,
	NoteImage,
	UserImage,
	Password,
	Session,
	Connection,
	Passkey,
	Role,
	_PermissionToRole,
	Permission,
	_RoleToUser,
	Organization,
	OrganizationImage,
	UtmSource,
	Integration,
	NoteIntegrationConnection,
	OrganizationNote,
	IntegrationLog,
	NoteAccess,
	NoteComment,
	NoteActivityLog,
	NoteCommentImage,
	OnboardingStep,
	OnboardingStepProgress,
	OnboardingProgress,
	OrganizationNoteFavorite,
	OrganizationNoteUpload,
	Feedback,
	IpAddress,
	IpAddressUser,
	OrganizationS3Config,
	StorageMigration,
	OrganizationNoteStatus,
	_OrganizationPermissionToRole,
	OrganizationRole,
	OrganizationInvitation,
	OrganizationInviteLink,
	UserOrganization,
	ConfigFlag,
	RefreshToken,
	SSOConfiguration,
	SSOSession,
	AuditLog,
	AuditLogRetentionPolicy,
	MCPAuthorization,
	MCPAccessToken,
	MCPRefreshToken,
	WaitlistEntry,
	BackupCode,
	ImpersonationSession,
	DataSubjectRequest,
	ApiKey,
	OrganizationAnnouncement,
	OrganizationSiteAsset,
	OrganizationMediaAsset,
	WebsitePage,
	WebsitePageSection,
	WebsiteRedirect,
	WebsiteNotFoundLog,
	NotificationPreference,
	Notification,
	SavedReport,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuOption,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuModifierOption,
	OrganizationMenuLocationOverride,
} from './schema.ts'

export const NoteRelations = relations(Note, ({ one, many }) => ({
	owner: one(User, {
		fields: [Note.ownerId],
		references: [User.id],
	}),
	images: many(NoteImage),
}))

export const UserRelations = relations(User, ({ one, many }) => ({
	notes: many(Note),
	image: one(UserImage),
	password: one(Password),
	sessions: many(Session),
	connections: many(Connection),
	passkey: many(Passkey),
	roleToUsers: many(_RoleToUser),
	utmSource: one(UtmSource),
	noteAccess: many(NoteAccess),
	noteComments: many(NoteComment),
	targetedActivityLogs: many(NoteActivityLog, {
		relationName: 'NoteActivityLog_targetUserId_User_id',
	}),
	activityLogs: many(NoteActivityLog, {
		relationName: 'NoteActivityLog_userId_User_id',
	}),
	onboardingStepProgress: many(OnboardingStepProgress),
	onboardingProgress: many(OnboardingProgress),
	orgNoteFavorites: many(OrganizationNoteFavorite),
	user: one(User, {
		fields: [User.bannedById],
		references: [User.id],
		relationName: 'User_bannedById_User_id',
	}),
	bannedUsers: many(User, {
		relationName: 'User_bannedById_User_id',
	}),
	feedback: many(Feedback),
	blacklistedIps: many(IpAddress),
	ipAddressUsers: many(IpAddressUser),
	organizationNotes: many(OrganizationNote),
	sentInvitations: many(OrganizationInvitation),
	createdInviteLinks: many(OrganizationInviteLink),
	organizations: many(UserOrganization),
	configFlags: many(ConfigFlag),
	refreshTokens: many(RefreshToken),
	createdSSOConfigs: many(SSOConfiguration),
	auditLogs: many(AuditLog),
	mcpAuthorizations: many(MCPAuthorization),
	grantedWaitlistAccess: many(WaitlistEntry, {
		relationName: 'WaitlistEntry_grantedAccessBy_User_id',
	}),
	waitlistEntry: one(WaitlistEntry, {
		fields: [User.id],
		references: [WaitlistEntry.userId],
		relationName: 'WaitlistEntry_userId_User_id',
	}),
	backupCodes: many(BackupCode),
	impersonationSessionsAsTarget: many(ImpersonationSession, {
		relationName: 'ImpersonationSession_targetUserId_User_id',
	}),
	impersonationSessionsAsAdmin: many(ImpersonationSession, {
		relationName: 'ImpersonationSession_adminUserId_User_id',
	}),
	dataSubjectRequests: many(DataSubjectRequest),
	apiKeys: many(ApiKey),
	createdWebsitePages: many(WebsitePage),
	notificationPreferences: many(NotificationPreference),
	notifications: many(Notification),
	savedReports: many(SavedReport),
	createdMediaAssets: many(OrganizationMediaAsset),
}))

export const NoteImageRelations = relations(NoteImage, ({ one }) => ({
	note: one(Note, {
		fields: [NoteImage.noteId],
		references: [Note.id],
	}),
}))

export const UserImageRelations = relations(UserImage, ({ one }) => ({
	user: one(User, {
		fields: [UserImage.userId],
		references: [User.id],
	}),
}))

export const PasswordRelations = relations(Password, ({ one }) => ({
	user: one(User, {
		fields: [Password.userId],
		references: [User.id],
	}),
}))

export const SessionRelations = relations(Session, ({ one }) => ({
	user: one(User, {
		fields: [Session.userId],
		references: [User.id],
	}),
	ssoSession: one(SSOSession),
}))

export const ConnectionRelations = relations(Connection, ({ one }) => ({
	user: one(User, {
		fields: [Connection.userId],
		references: [User.id],
	}),
}))

export const PasskeyRelations = relations(Passkey, ({ one }) => ({
	user: one(User, {
		fields: [Passkey.userId],
		references: [User.id],
	}),
}))

export const _PermissionToRoleRelations = relations(
	_PermissionToRole,
	({ one }) => ({
		role: one(Role, {
			fields: [_PermissionToRole.B],
			references: [Role.id],
		}),
		permission: one(Permission, {
			fields: [_PermissionToRole.A],
			references: [Permission.id],
		}),
	}),
)

export const RoleRelations = relations(Role, ({ many }) => ({
	permissionToRoles: many(_PermissionToRole),
	roleToUsers: many(_RoleToUser),
}))

export const PermissionRelations = relations(Permission, ({ many }) => ({
	permissionToRoles: many(_PermissionToRole),
	organizationPermissionToRoles: many(_OrganizationPermissionToRole),
}))

export const _RoleToUserRelations = relations(_RoleToUser, ({ one }) => ({
	user: one(User, {
		fields: [_RoleToUser.B],
		references: [User.id],
	}),
	role: one(Role, {
		fields: [_RoleToUser.A],
		references: [Role.id],
	}),
}))

export const OrganizationImageRelations = relations(
	OrganizationImage,
	({ one }) => ({
		organization: one(Organization, {
			fields: [OrganizationImage.organizationId],
			references: [Organization.id],
		}),
	}),
)

export const OrganizationRelations = relations(Organization, ({ many }) => ({
	images: many(OrganizationImage),
	integrations: many(Integration),
	onboardingStepProgress: many(OnboardingStepProgress),
	onboardingProgress: many(OnboardingProgress),
	feedback: many(Feedback),
	s3Configs: many(OrganizationS3Config),
	storageMigrations: many(StorageMigration),
	organizationNotes: many(OrganizationNote),
	noteStatuses: many(OrganizationNoteStatus),
	organizationRoles: many(OrganizationRole),
	sentInvitations: many(OrganizationInvitation),
	createdInviteLinks: many(OrganizationInviteLink),
	organizations: many(UserOrganization),
	configFlags: many(ConfigFlag),
	createdSSOConfigs: many(SSOConfiguration),
	auditLogs: many(AuditLog),
	auditLogRetentionPolicies: many(AuditLogRetentionPolicy),
	mcpAuthorizations: many(MCPAuthorization),
	apiKeys: many(ApiKey),
	announcements: many(OrganizationAnnouncement),
	siteAssets: many(OrganizationSiteAsset),
	mediaAssets: many(OrganizationMediaAsset),
	createdWebsitePages: many(WebsitePage),
	websiteRedirects: many(WebsiteRedirect),
	websiteNotFoundLogs: many(WebsiteNotFoundLog),
	notificationPreferences: many(NotificationPreference),
	notifications: many(Notification),
	savedReports: many(SavedReport),
	locations: many(OrganizationLocation),
	menus: many(OrganizationMenu),
	menuCategories: many(OrganizationMenuCategory),
	menuItems: many(OrganizationMenuItem),
	menuModifierGroups: many(OrganizationMenuModifierGroup),
	menuOptions: many(OrganizationMenuOption),
	menuLocationOverrides: many(OrganizationMenuLocationOverride),
}))

export const OrganizationLocationRelations = relations(
	OrganizationLocation,
	({ one, many }) => ({
		organization: one(Organization, {
			fields: [OrganizationLocation.organizationId],
			references: [Organization.id],
		}),
		menuOverrides: many(OrganizationMenuLocationOverride),
	}),
)

export const UtmSourceRelations = relations(UtmSource, ({ one }) => ({
	user: one(User, {
		fields: [UtmSource.userId],
		references: [User.id],
	}),
}))

export const IntegrationRelations = relations(Integration, ({ one, many }) => ({
	organization: one(Organization, {
		fields: [Integration.organizationId],
		references: [Organization.id],
	}),
	noteConnections: many(NoteIntegrationConnection),
	logs: many(IntegrationLog),
	activityLogs: many(NoteActivityLog),
}))

export const NoteIntegrationConnectionRelations = relations(
	NoteIntegrationConnection,
	({ one }) => ({
		integration: one(Integration, {
			fields: [NoteIntegrationConnection.integrationId],
			references: [Integration.id],
		}),
		note: one(OrganizationNote, {
			fields: [NoteIntegrationConnection.noteId],
			references: [OrganizationNote.id],
		}),
	}),
)

export const OrganizationNoteRelations = relations(
	OrganizationNote,
	({ one, many }) => ({
		noteConnections: many(NoteIntegrationConnection),
		noteAccess: many(NoteAccess),
		noteComments: many(NoteComment),
		activityLogs: many(NoteActivityLog),
		orgNoteFavorites: many(OrganizationNoteFavorite),
		organizationNoteUploads: many(OrganizationNoteUpload),
		organization: one(Organization, {
			fields: [OrganizationNote.organizationId],
			references: [Organization.id],
		}),
		user: one(User, {
			fields: [OrganizationNote.createdById],
			references: [User.id],
		}),
		status: one(OrganizationNoteStatus, {
			fields: [OrganizationNote.statusId],
			references: [OrganizationNoteStatus.id],
		}),
	}),
)

export const IntegrationLogRelations = relations(IntegrationLog, ({ one }) => ({
	integration: one(Integration, {
		fields: [IntegrationLog.integrationId],
		references: [Integration.id],
	}),
}))

export const NoteAccessRelations = relations(NoteAccess, ({ one }) => ({
	user: one(User, {
		fields: [NoteAccess.userId],
		references: [User.id],
	}),
	note: one(OrganizationNote, {
		fields: [NoteAccess.noteId],
		references: [OrganizationNote.id],
	}),
}))

export const NoteCommentRelations = relations(NoteComment, ({ one, many }) => ({
	parent: one(NoteComment, {
		fields: [NoteComment.parentId],
		references: [NoteComment.id],
		relationName: 'NoteComment_parentId_NoteComment_id',
	}),
	noteComments: many(NoteComment, {
		relationName: 'NoteComment_parentId_NoteComment_id',
	}),
	user: one(User, {
		fields: [NoteComment.userId],
		references: [User.id],
	}),
	note: one(OrganizationNote, {
		fields: [NoteComment.noteId],
		references: [OrganizationNote.id],
	}),
	images: many(NoteCommentImage),
}))

export const NoteActivityLogRelations = relations(
	NoteActivityLog,
	({ one }) => ({
		integration: one(Integration, {
			fields: [NoteActivityLog.integrationId],
			references: [Integration.id],
		}),
		targetUser: one(User, {
			fields: [NoteActivityLog.targetUserId],
			references: [User.id],
			relationName: 'NoteActivityLog_targetUserId_User_id',
		}),
		user: one(User, {
			fields: [NoteActivityLog.userId],
			references: [User.id],
			relationName: 'NoteActivityLog_userId_User_id',
		}),
		note: one(OrganizationNote, {
			fields: [NoteActivityLog.noteId],
			references: [OrganizationNote.id],
		}),
	}),
)

export const NoteCommentImageRelations = relations(
	NoteCommentImage,
	({ one }) => ({
		parent: one(NoteComment, {
			fields: [NoteCommentImage.commentId],
			references: [NoteComment.id],
		}),
	}),
)

export const OnboardingStepProgressRelations = relations(
	OnboardingStepProgress,
	({ one }) => ({
		step: one(OnboardingStep, {
			fields: [OnboardingStepProgress.stepId],
			references: [OnboardingStep.id],
		}),
		organization: one(Organization, {
			fields: [OnboardingStepProgress.organizationId],
			references: [Organization.id],
		}),
		user: one(User, {
			fields: [OnboardingStepProgress.userId],
			references: [User.id],
		}),
	}),
)

export const OnboardingStepRelations = relations(
	OnboardingStep,
	({ many }) => ({
		onboardingStepProgress: many(OnboardingStepProgress),
	}),
)

export const OnboardingProgressRelations = relations(
	OnboardingProgress,
	({ one }) => ({
		organization: one(Organization, {
			fields: [OnboardingProgress.organizationId],
			references: [Organization.id],
		}),
		user: one(User, {
			fields: [OnboardingProgress.userId],
			references: [User.id],
		}),
	}),
)

export const OrganizationNoteFavoriteRelations = relations(
	OrganizationNoteFavorite,
	({ one }) => ({
		note: one(OrganizationNote, {
			fields: [OrganizationNoteFavorite.noteId],
			references: [OrganizationNote.id],
		}),
		user: one(User, {
			fields: [OrganizationNoteFavorite.userId],
			references: [User.id],
		}),
	}),
)

export const OrganizationNoteUploadRelations = relations(
	OrganizationNoteUpload,
	({ one }) => ({
		note: one(OrganizationNote, {
			fields: [OrganizationNoteUpload.noteId],
			references: [OrganizationNote.id],
		}),
	}),
)

export const FeedbackRelations = relations(Feedback, ({ one }) => ({
	organization: one(Organization, {
		fields: [Feedback.organizationId],
		references: [Organization.id],
	}),
	user: one(User, {
		fields: [Feedback.userId],
		references: [User.id],
	}),
}))

export const IpAddressRelations = relations(IpAddress, ({ one, many }) => ({
	user: one(User, {
		fields: [IpAddress.blacklistedById],
		references: [User.id],
	}),
	ipAddressUsers: many(IpAddressUser),
}))

export const IpAddressUserRelations = relations(IpAddressUser, ({ one }) => ({
	ipAddress: one(IpAddress, {
		fields: [IpAddressUser.ipAddressId],
		references: [IpAddress.id],
	}),
	user: one(User, {
		fields: [IpAddressUser.userId],
		references: [User.id],
	}),
}))

export const OrganizationS3ConfigRelations = relations(
	OrganizationS3Config,
	({ one }) => ({
		organization: one(Organization, {
			fields: [OrganizationS3Config.organizationId],
			references: [Organization.id],
		}),
	}),
)

export const StorageMigrationRelations = relations(
	StorageMigration,
	({ one }) => ({
		organization: one(Organization, {
			fields: [StorageMigration.organizationId],
			references: [Organization.id],
		}),
	}),
)

export const OrganizationNoteStatusRelations = relations(
	OrganizationNoteStatus,
	({ one, many }) => ({
		organizationNotes: many(OrganizationNote),
		organization: one(Organization, {
			fields: [OrganizationNoteStatus.organizationId],
			references: [Organization.id],
		}),
	}),
)

export const _OrganizationPermissionToRoleRelations = relations(
	_OrganizationPermissionToRole,
	({ one }) => ({
		permission: one(Permission, {
			fields: [_OrganizationPermissionToRole.B],
			references: [Permission.id],
		}),
		organizationRole: one(OrganizationRole, {
			fields: [_OrganizationPermissionToRole.A],
			references: [OrganizationRole.id],
		}),
	}),
)

export const OrganizationRoleRelations = relations(
	OrganizationRole,
	({ one, many }) => ({
		organization: one(Organization, {
			fields: [OrganizationRole.organizationId],
			references: [Organization.id],
		}),
		organizationPermissionToRoles: many(_OrganizationPermissionToRole),
		sentInvitations: many(OrganizationInvitation),
		createdInviteLinks: many(OrganizationInviteLink),
		organizations: many(UserOrganization),
	}),
)

export const OrganizationInvitationRelations = relations(
	OrganizationInvitation,
	({ one }) => ({
		organization: one(Organization, {
			fields: [OrganizationInvitation.organizationId],
			references: [Organization.id],
		}),
		user: one(User, {
			fields: [OrganizationInvitation.inviterId],
			references: [User.id],
		}),
		organizationRole: one(OrganizationRole, {
			fields: [OrganizationInvitation.organizationRoleId],
			references: [OrganizationRole.id],
		}),
	}),
)

export const OrganizationInviteLinkRelations = relations(
	OrganizationInviteLink,
	({ one }) => ({
		organization: one(Organization, {
			fields: [OrganizationInviteLink.organizationId],
			references: [Organization.id],
		}),
		user: one(User, {
			fields: [OrganizationInviteLink.createdById],
			references: [User.id],
		}),
		organizationRole: one(OrganizationRole, {
			fields: [OrganizationInviteLink.organizationRoleId],
			references: [OrganizationRole.id],
		}),
	}),
)

export const UserOrganizationRelations = relations(
	UserOrganization,
	({ one }) => ({
		user: one(User, {
			fields: [UserOrganization.userId],
			references: [User.id],
		}),
		organization: one(Organization, {
			fields: [UserOrganization.organizationId],
			references: [Organization.id],
		}),
		organizationRole: one(OrganizationRole, {
			fields: [UserOrganization.organizationRoleId],
			references: [OrganizationRole.id],
		}),
	}),
)

export const ConfigFlagRelations = relations(ConfigFlag, ({ one }) => ({
	user: one(User, {
		fields: [ConfigFlag.userId],
		references: [User.id],
	}),
	organization: one(Organization, {
		fields: [ConfigFlag.organizationId],
		references: [Organization.id],
	}),
}))

export const RefreshTokenRelations = relations(RefreshToken, ({ one }) => ({
	user: one(User, {
		fields: [RefreshToken.userId],
		references: [User.id],
	}),
}))

export const SSOConfigurationRelations = relations(
	SSOConfiguration,
	({ one, many }) => ({
		user: one(User, {
			fields: [SSOConfiguration.createdById],
			references: [User.id],
		}),
		organization: one(Organization, {
			fields: [SSOConfiguration.organizationId],
			references: [Organization.id],
		}),
		ssoSessions: many(SSOSession),
	}),
)

export const SSOSessionRelations = relations(SSOSession, ({ one }) => ({
	ssoConfiguration: one(SSOConfiguration, {
		fields: [SSOSession.ssoConfigId],
		references: [SSOConfiguration.id],
	}),
	session: one(Session, {
		fields: [SSOSession.sessionId],
		references: [Session.id],
	}),
}))

export const AuditLogRelations = relations(AuditLog, ({ one }) => ({
	user: one(User, {
		fields: [AuditLog.userId],
		references: [User.id],
	}),
	organization: one(Organization, {
		fields: [AuditLog.organizationId],
		references: [Organization.id],
	}),
}))

export const AuditLogRetentionPolicyRelations = relations(
	AuditLogRetentionPolicy,
	({ one }) => ({
		organization: one(Organization, {
			fields: [AuditLogRetentionPolicy.organizationId],
			references: [Organization.id],
		}),
	}),
)

export const MCPAuthorizationRelations = relations(
	MCPAuthorization,
	({ one, many }) => ({
		organization: one(Organization, {
			fields: [MCPAuthorization.organizationId],
			references: [Organization.id],
		}),
		user: one(User, {
			fields: [MCPAuthorization.userId],
			references: [User.id],
		}),
		accessTokens: many(MCPAccessToken),
		refreshTokens: many(MCPRefreshToken),
	}),
)

export const MCPAccessTokenRelations = relations(MCPAccessToken, ({ one }) => ({
	authorization: one(MCPAuthorization, {
		fields: [MCPAccessToken.authorizationId],
		references: [MCPAuthorization.id],
	}),
}))

export const MCPRefreshTokenRelations = relations(
	MCPRefreshToken,
	({ one }) => ({
		authorization: one(MCPAuthorization, {
			fields: [MCPRefreshToken.authorizationId],
			references: [MCPAuthorization.id],
		}),
	}),
)

export const WaitlistEntryRelations = relations(
	WaitlistEntry,
	({ one, many }) => ({
		referredBy: one(WaitlistEntry, {
			fields: [WaitlistEntry.referredById],
			references: [WaitlistEntry.id],
			relationName: 'WaitlistEntry_referredById_WaitlistEntry_id',
		}),
		referrals: many(WaitlistEntry, {
			relationName: 'WaitlistEntry_referredById_WaitlistEntry_id',
		}),
		grantedAccessByUser: one(User, {
			fields: [WaitlistEntry.grantedAccessBy],
			references: [User.id],
			relationName: 'WaitlistEntry_grantedAccessBy_User_id',
		}),
		user: one(User, {
			fields: [WaitlistEntry.userId],
			references: [User.id],
			relationName: 'WaitlistEntry_userId_User_id',
		}),
	}),
)

export const BackupCodeRelations = relations(BackupCode, ({ one }) => ({
	user: one(User, {
		fields: [BackupCode.userId],
		references: [User.id],
	}),
}))

export const ImpersonationSessionRelations = relations(
	ImpersonationSession,
	({ one }) => ({
		targetUser: one(User, {
			fields: [ImpersonationSession.targetUserId],
			references: [User.id],
			relationName: 'ImpersonationSession_targetUserId_User_id',
		}),
		adminUser: one(User, {
			fields: [ImpersonationSession.adminUserId],
			references: [User.id],
			relationName: 'ImpersonationSession_adminUserId_User_id',
		}),
	}),
)

export const DataSubjectRequestRelations = relations(
	DataSubjectRequest,
	({ one }) => ({
		user: one(User, {
			fields: [DataSubjectRequest.userId],
			references: [User.id],
		}),
	}),
)

export const ApiKeyRelations = relations(ApiKey, ({ one }) => ({
	organization: one(Organization, {
		fields: [ApiKey.organizationId],
		references: [Organization.id],
	}),
	user: one(User, {
		fields: [ApiKey.userId],
		references: [User.id],
	}),
}))

export const OrganizationAnnouncementRelations = relations(
	OrganizationAnnouncement,
	({ one }) => ({
		organization: one(Organization, {
			fields: [OrganizationAnnouncement.organizationId],
			references: [Organization.id],
		}),
	}),
)

export const OrganizationSiteAssetRelations = relations(
	OrganizationSiteAsset,
	({ one }) => ({
		organization: one(Organization, {
			fields: [OrganizationSiteAsset.organizationId],
			references: [Organization.id],
		}),
	}),
)

export const OrganizationMediaAssetRelations = relations(
	OrganizationMediaAsset,
	({ one }) => ({
		organization: one(Organization, {
			fields: [OrganizationMediaAsset.organizationId],
			references: [Organization.id],
		}),
		createdBy: one(User, {
			fields: [OrganizationMediaAsset.createdById],
			references: [User.id],
		}),
	}),
)

export const WebsitePageRelations = relations(WebsitePage, ({ one, many }) => ({
	user: one(User, {
		fields: [WebsitePage.createdById],
		references: [User.id],
	}),
	organization: one(Organization, {
		fields: [WebsitePage.organizationId],
		references: [Organization.id],
	}),
	sections: many(WebsitePageSection),
}))

export const WebsitePageSectionRelations = relations(
	WebsitePageSection,
	({ one }) => ({
		page: one(WebsitePage, {
			fields: [WebsitePageSection.pageId],
			references: [WebsitePage.id],
		}),
	}),
)

export const NotificationPreferenceRelations = relations(
	NotificationPreference,
	({ one }) => ({
		organization: one(Organization, {
			fields: [NotificationPreference.organizationId],
			references: [Organization.id],
		}),
		user: one(User, {
			fields: [NotificationPreference.userId],
			references: [User.id],
		}),
	}),
)

export const NotificationRelations = relations(Notification, ({ one }) => ({
	organization: one(Organization, {
		fields: [Notification.organizationId],
		references: [Organization.id],
	}),
	user: one(User, {
		fields: [Notification.userId],
		references: [User.id],
	}),
}))

export const SavedReportRelations = relations(SavedReport, ({ one }) => ({
	organization: one(Organization, {
		fields: [SavedReport.organizationId],
		references: [Organization.id],
	}),
	createdBy: one(User, {
		fields: [SavedReport.createdById],
		references: [User.id],
	}),
}))

export const WebsiteRedirectRelations = relations(
	WebsiteRedirect,
	({ one }) => ({
		organization: one(Organization, {
			fields: [WebsiteRedirect.organizationId],
			references: [Organization.id],
		}),
	}),
)

export const WebsiteNotFoundLogRelations = relations(
	WebsiteNotFoundLog,
	({ one }) => ({
		organization: one(Organization, {
			fields: [WebsiteNotFoundLog.organizationId],
			references: [Organization.id],
		}),
	}),
)

export const OrganizationMenuRelations = relations(
	OrganizationMenu,
	({ one, many }) => ({
		organization: one(Organization, {
			fields: [OrganizationMenu.organizationId],
			references: [Organization.id],
		}),
		categoryAssignments: many(OrganizationMenuCategoryAssignment),
	}),
)

export const OrganizationMenuCategoryRelations = relations(
	OrganizationMenuCategory,
	({ one, many }) => ({
		organization: one(Organization, {
			fields: [OrganizationMenuCategory.organizationId],
			references: [Organization.id],
		}),
		menuAssignments: many(OrganizationMenuCategoryAssignment),
		itemAssignments: many(OrganizationMenuItemCategoryAssignment),
	}),
)

export const OrganizationMenuCategoryAssignmentRelations = relations(
	OrganizationMenuCategoryAssignment,
	({ one }) => ({
		menu: one(OrganizationMenu, {
			fields: [OrganizationMenuCategoryAssignment.menuId],
			references: [OrganizationMenu.id],
		}),
		category: one(OrganizationMenuCategory, {
			fields: [OrganizationMenuCategoryAssignment.categoryId],
			references: [OrganizationMenuCategory.id],
		}),
	}),
)

export const OrganizationMenuItemRelations = relations(
	OrganizationMenuItem,
	({ one, many }) => ({
		organization: one(Organization, {
			fields: [OrganizationMenuItem.organizationId],
			references: [Organization.id],
		}),
		categoryAssignments: many(OrganizationMenuItemCategoryAssignment),
		modifierGroupAssignments: many(OrganizationMenuItemModifierGroupAssignment),
	}),
)

export const OrganizationMenuItemCategoryAssignmentRelations = relations(
	OrganizationMenuItemCategoryAssignment,
	({ one }) => ({
		category: one(OrganizationMenuCategory, {
			fields: [OrganizationMenuItemCategoryAssignment.categoryId],
			references: [OrganizationMenuCategory.id],
		}),
		item: one(OrganizationMenuItem, {
			fields: [OrganizationMenuItemCategoryAssignment.itemId],
			references: [OrganizationMenuItem.id],
		}),
	}),
)

export const OrganizationMenuModifierGroupRelations = relations(
	OrganizationMenuModifierGroup,
	({ one, many }) => ({
		organization: one(Organization, {
			fields: [OrganizationMenuModifierGroup.organizationId],
			references: [Organization.id],
		}),
		options: many(OrganizationMenuModifierOption),
		optionAssignments: many(OrganizationMenuModifierGroupOptionAssignment),
		itemAssignments: many(OrganizationMenuItemModifierGroupAssignment),
	}),
)

export const OrganizationMenuOptionRelations = relations(
	OrganizationMenuOption,
	({ one, many }) => ({
		organization: one(Organization, {
			fields: [OrganizationMenuOption.organizationId],
			references: [Organization.id],
		}),
		modifierGroupAssignments: many(
			OrganizationMenuModifierGroupOptionAssignment,
		),
	}),
)

export const OrganizationMenuModifierGroupOptionAssignmentRelations = relations(
	OrganizationMenuModifierGroupOptionAssignment,
	({ one }) => ({
		modifierGroup: one(OrganizationMenuModifierGroup, {
			fields: [OrganizationMenuModifierGroupOptionAssignment.modifierGroupId],
			references: [OrganizationMenuModifierGroup.id],
		}),
		option: one(OrganizationMenuOption, {
			fields: [OrganizationMenuModifierGroupOptionAssignment.optionId],
			references: [OrganizationMenuOption.id],
		}),
	}),
)

export const OrganizationMenuItemModifierGroupAssignmentRelations = relations(
	OrganizationMenuItemModifierGroupAssignment,
	({ one }) => ({
		item: one(OrganizationMenuItem, {
			fields: [OrganizationMenuItemModifierGroupAssignment.itemId],
			references: [OrganizationMenuItem.id],
		}),
		modifierGroup: one(OrganizationMenuModifierGroup, {
			fields: [OrganizationMenuItemModifierGroupAssignment.modifierGroupId],
			references: [OrganizationMenuModifierGroup.id],
		}),
	}),
)

export const OrganizationMenuModifierOptionRelations = relations(
	OrganizationMenuModifierOption,
	({ one }) => ({
		modifierGroup: one(OrganizationMenuModifierGroup, {
			fields: [OrganizationMenuModifierOption.modifierGroupId],
			references: [OrganizationMenuModifierGroup.id],
		}),
	}),
)

export const OrganizationMenuLocationOverrideRelations = relations(
	OrganizationMenuLocationOverride,
	({ one }) => ({
		organization: one(Organization, {
			fields: [OrganizationMenuLocationOverride.organizationId],
			references: [Organization.id],
		}),
		location: one(OrganizationLocation, {
			fields: [OrganizationMenuLocationOverride.locationId],
			references: [OrganizationLocation.id],
		}),
	}),
)
