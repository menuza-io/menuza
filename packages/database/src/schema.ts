/**
 * Control-plane SQLite schema for Drizzle.
 *
 * DATETIME columns use millisecond timestamps and BOOLEAN columns use 0/1
 * integers. Schema changes: `drizzle-kit generate`, then `tsx src/migrate.ts`.
 */
import { createId } from '@paralleldrive/cuid2'
import {
	blob,
	foreignKey,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const Note = sqliteTable(
	'Note',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		title: text().notNull(),
		content: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		ownerId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
	},
	(table) => [
		index('Note_ownerId_updatedAt_idx').on(table.ownerId, table.updatedAt),
		index('Note_ownerId_idx').on(table.ownerId),
	],
)

export const NoteImage = sqliteTable(
	'NoteImage',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		altText: text(),
		objectKey: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		noteId: text()
			.notNull()
			.references(() => Note.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
	},
	(table) => [index('NoteImage_noteId_idx').on(table.noteId)],
)

export const UserImage = sqliteTable(
	'UserImage',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		altText: text(),
		objectKey: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
	},
	(table) => [uniqueIndex('UserImage_userId_key').on(table.userId)],
)

export const Password = sqliteTable(
	'Password',
	{
		hash: text().notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
	},
	(table) => [uniqueIndex('Password_userId_key').on(table.userId)],
)

export const Session = sqliteTable(
	'Session',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		expirationDate: integer({ mode: 'timestamp_ms' }).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		ipAddress: text(),
		userAgent: text(),
	},
	(table) => [index('Session_userId_idx').on(table.userId)],
)

export const Role = sqliteTable(
	'Role',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		name: text().notNull(),
		description: text().default('').notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [uniqueIndex('Role_name_key').on(table.name)],
)

export const Verification = sqliteTable(
	'Verification',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		type: text().notNull(),
		target: text().notNull(),
		secret: text().notNull(),
		algorithm: text().notNull(),
		digits: integer().notNull(),
		period: integer().notNull(),
		charSet: text().notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }),
	},
	(table) => [
		uniqueIndex('Verification_target_type_key').on(table.target, table.type),
	],
)

export const Connection = sqliteTable(
	'Connection',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		providerName: text().notNull(),
		providerId: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
	},
	(table) => [
		uniqueIndex('Connection_providerName_providerId_key').on(
			table.providerName,
			table.providerId,
		),
	],
)

export const Passkey = sqliteTable(
	'Passkey',
	{
		id: text().primaryKey().notNull(),
		aaguid: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		publicKey: blob({ mode: 'buffer' }).notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		webauthnUserId: text().notNull(),
		counter: integer().notNull(),
		deviceType: text().notNull(),
		backedUp: integer({ mode: 'boolean' }).notNull(),
		transports: text(),
	},
	(table) => [index('Passkey_userId_idx').on(table.userId)],
)

export const _PermissionToRole = sqliteTable(
	'_PermissionToRole',
	{
		A: text()
			.notNull()
			.references(() => Permission.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		B: text()
			.notNull()
			.references(() => Role.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
	},
	(table) => [
		index('_PermissionToRole_B_index').on(table.B),
		uniqueIndex('_PermissionToRole_AB_unique').on(table.A, table.B),
	],
)

export const _RoleToUser = sqliteTable(
	'_RoleToUser',
	{
		A: text()
			.notNull()
			.references(() => Role.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		B: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
	},
	(table) => [
		index('_RoleToUser_B_index').on(table.B),
		uniqueIndex('_RoleToUser_AB_unique').on(table.A, table.B),
	],
)

export const OrganizationImage = sqliteTable(
	'OrganizationImage',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		altText: text(),
		objectKey: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
	},
	(table) => [
		uniqueIndex('OrganizationImage_organizationId_key').on(
			table.organizationId,
		),
	],
)

export const UtmSource = sqliteTable(
	'UtmSource',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		source: text(),
		medium: text(),
		campaign: text(),
		term: text(),
		content: text(),
		referrer: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
	},
	(table) => [uniqueIndex('UtmSource_userId_key').on(table.userId)],
)

export const Integration = sqliteTable(
	'Integration',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		providerName: text().notNull(),
		providerType: text().notNull(),
		accessToken: text(),
		refreshToken: text(),
		tokenExpiresAt: integer({ mode: 'timestamp_ms' }),
		config: text().notNull(),
		isActive: integer({ mode: 'boolean' }).default(true).notNull(),
		lastSyncAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('Integration_organizationId_providerName_key').on(
			table.organizationId,
			table.providerName,
		),
		index('Integration_organizationId_idx').on(table.organizationId),
	],
)

export const NoteIntegrationConnection = sqliteTable(
	'NoteIntegrationConnection',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		noteId: text()
			.notNull()
			.references(() => OrganizationNote.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		integrationId: text()
			.notNull()
			.references(() => Integration.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		externalId: text().notNull(),
		config: text().notNull(),
		isActive: integer({ mode: 'boolean' }).default(true).notNull(),
		lastPostedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex(
			'NoteIntegrationConnection_noteId_integrationId_externalId_key',
		).on(table.noteId, table.integrationId, table.externalId),
		index('NoteIntegrationConnection_integrationId_idx').on(
			table.integrationId,
		),
		index('NoteIntegrationConnection_noteId_idx').on(table.noteId),
	],
)

export const IntegrationLog = sqliteTable(
	'IntegrationLog',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		integrationId: text()
			.notNull()
			.references(() => Integration.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		action: text().notNull(),
		status: text().notNull(),
		requestData: text(),
		responseData: text(),
		errorMessage: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('IntegrationLog_createdAt_idx').on(table.createdAt),
		index('IntegrationLog_integrationId_idx').on(table.integrationId),
	],
)

export const NoteAccess = sqliteTable(
	'NoteAccess',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		noteId: text()
			.notNull()
			.references(() => OrganizationNote.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('NoteAccess_noteId_userId_key').on(table.noteId, table.userId),
		index('NoteAccess_userId_idx').on(table.userId),
		index('NoteAccess_noteId_idx').on(table.noteId),
	],
)

export const NoteComment = sqliteTable(
	'NoteComment',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		content: text().notNull(),
		noteId: text()
			.notNull()
			.references(() => OrganizationNote.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		parentId: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('NoteComment_noteId_createdAt_idx').on(table.noteId, table.createdAt),
		index('NoteComment_parentId_idx').on(table.parentId),
		index('NoteComment_userId_idx').on(table.userId),
		index('NoteComment_noteId_idx').on(table.noteId),
		foreignKey(() => ({
			columns: [table.parentId],
			foreignColumns: [table.id],
			name: 'NoteComment_parentId_NoteComment_id_fk',
		}))
			.onUpdate('cascade')
			.onDelete('cascade'),
	],
)

export const NoteActivityLog = sqliteTable(
	'NoteActivityLog',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		noteId: text()
			.notNull()
			.references(() => OrganizationNote.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		action: text().notNull(),
		metadata: text(),
		targetUserId: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		integrationId: text().references(() => Integration.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		commentId: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('NoteActivityLog_action_idx').on(table.action),
		index('NoteActivityLog_noteId_createdAt_idx').on(
			table.noteId,
			table.createdAt,
		),
		index('NoteActivityLog_userId_idx').on(table.userId),
		index('NoteActivityLog_noteId_idx').on(table.noteId),
	],
)

export const NoteCommentImage = sqliteTable(
	'NoteCommentImage',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		altText: text(),
		objectKey: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		commentId: text()
			.notNull()
			.references(() => NoteComment.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
	},
	(table) => [index('NoteCommentImage_commentId_idx').on(table.commentId)],
)

export const OnboardingStep = sqliteTable(
	'OnboardingStep',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		key: text().notNull(),
		title: text().notNull(),
		description: text().notNull(),
		icon: text(),
		actionConfig: text(),
		isActive: integer({ mode: 'boolean' }).default(true).notNull(),
		sortOrder: integer().default(0).notNull(),
		autoDetect: integer({ mode: 'boolean' }).default(false).notNull(),
		detectConfig: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OnboardingStep_isActive_sortOrder_idx').on(
			table.isActive,
			table.sortOrder,
		),
		uniqueIndex('OnboardingStep_key_key').on(table.key),
	],
)

export const OnboardingStepProgress = sqliteTable(
	'OnboardingStepProgress',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		stepId: text()
			.notNull()
			.references(() => OnboardingStep.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		isCompleted: integer({ mode: 'boolean' }).default(false).notNull(),
		completedAt: integer({ mode: 'timestamp_ms' }),
		metadata: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('OnboardingStepProgress_userId_organizationId_stepId_key').on(
			table.userId,
			table.organizationId,
			table.stepId,
		),
		index('OnboardingStepProgress_stepId_idx').on(table.stepId),
		index('OnboardingStepProgress_userId_organizationId_idx').on(
			table.userId,
			table.organizationId,
		),
	],
)

export const OnboardingProgress = sqliteTable(
	'OnboardingProgress',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		totalSteps: integer().default(0).notNull(),
		completedCount: integer().default(0).notNull(),
		isCompleted: integer({ mode: 'boolean' }).default(false).notNull(),
		completedAt: integer({ mode: 'timestamp_ms' }),
		isVisible: integer({ mode: 'boolean' }).default(true).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('OnboardingProgress_userId_organizationId_key').on(
			table.userId,
			table.organizationId,
		),
		index('OnboardingProgress_organizationId_idx').on(table.organizationId),
		index('OnboardingProgress_userId_idx').on(table.userId),
	],
)

export const OrganizationNoteFavorite = sqliteTable(
	'OrganizationNoteFavorite',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		noteId: text()
			.notNull()
			.references(() => OrganizationNote.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('OrganizationNoteFavorite_userId_noteId_key').on(
			table.userId,
			table.noteId,
		),
		index('OrganizationNoteFavorite_noteId_idx').on(table.noteId),
		index('OrganizationNoteFavorite_userId_idx').on(table.userId),
	],
)

export const User = sqliteTable(
	'User',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		email: text().notNull(),
		username: text().notNull(),
		name: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		isBanned: integer({ mode: 'boolean' }).default(false).notNull(),
		banReason: text(),
		banExpiresAt: integer({ mode: 'timestamp_ms' }),
		bannedAt: integer({ mode: 'timestamp_ms' }),
		bannedById: text(),
	},
	(table) => [
		uniqueIndex('User_username_key').on(table.username),
		uniqueIndex('User_email_key').on(table.email),
		foreignKey(() => ({
			columns: [table.bannedById],
			foreignColumns: [table.id],
			name: 'User_bannedById_User_id_fk',
		}))
			.onUpdate('cascade')
			.onDelete('set null'),
	],
)

export const OrganizationNoteUpload = sqliteTable(
	'OrganizationNoteUpload',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		type: text().notNull(),
		altText: text(),
		objectKey: text().notNull(),
		thumbnailKey: text(),
		duration: integer(),
		fileSize: integer(),
		mimeType: text(),
		status: text().default('completed').notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		noteId: text()
			.notNull()
			.references(() => OrganizationNote.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
	},
	(table) => [
		index('OrganizationNoteUpload_noteId_type_idx').on(
			table.noteId,
			table.type,
		),
		index('OrganizationNoteUpload_status_idx').on(table.status),
		index('OrganizationNoteUpload_type_idx').on(table.type),
		index('OrganizationNoteUpload_noteId_idx').on(table.noteId),
	],
)

export const Feedback = sqliteTable(
	'Feedback',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		message: text().notNull(),
		type: text().notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
	},
	(table) => [
		index('Feedback_organizationId_idx').on(table.organizationId),
		index('Feedback_userId_idx').on(table.userId),
	],
)

export const IpAddress = sqliteTable(
	'IpAddress',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		ip: text().notNull(),
		country: text(),
		region: text(),
		city: text(),
		isBlacklisted: integer({ mode: 'boolean' }).default(false).notNull(),
		blacklistReason: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		blacklistedAt: integer({ mode: 'timestamp_ms' }),
		blacklistedById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		requestCount: integer().default(0).notNull(),
		lastRequestAt: integer({ mode: 'timestamp_ms' }),
		lastUserAgent: text(),
		suspiciousScore: integer().default(0).notNull(),
	},
	(table) => [
		index('IpAddress_suspiciousScore_idx').on(table.suspiciousScore),
		index('IpAddress_isBlacklisted_idx').on(table.isBlacklisted),
		index('IpAddress_ip_idx').on(table.ip),
		uniqueIndex('IpAddress_ip_key').on(table.ip),
	],
)

export const IpAddressUser = sqliteTable(
	'IpAddressUser',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		ipAddressId: text()
			.notNull()
			.references(() => IpAddress.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		firstSeenAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		lastSeenAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		requestCount: integer().default(1).notNull(),
	},
	(table) => [
		uniqueIndex('IpAddressUser_userId_ipAddressId_key').on(
			table.userId,
			table.ipAddressId,
		),
		index('IpAddressUser_ipAddressId_idx').on(table.ipAddressId),
		index('IpAddressUser_userId_idx').on(table.userId),
	],
)

export const OrganizationS3Config = sqliteTable(
	'OrganizationS3Config',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		isEnabled: integer({ mode: 'boolean' }).default(false).notNull(),
		endpoint: text().notNull(),
		bucketName: text().notNull(),
		accessKeyId: text().notNull(),
		secretAccessKey: text().notNull(),
		region: text().notNull(),
		previousEndpoint: text(),
		previousBucketName: text(),
		previousAccessKeyId: text(),
		previousSecretAccessKey: text(),
		previousRegion: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
	},
	(table) => [
		uniqueIndex('OrganizationS3Config_organizationId_key').on(
			table.organizationId,
		),
	],
)

export const StorageMigration = sqliteTable(
	'StorageMigration',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		status: text().notNull().default('pending'),
		sourceType: text().notNull(),
		sourceEndpoint: text(),
		sourceBucketName: text(),
		sourceAccessKeyId: text(),
		sourceSecretAccessKey: text(),
		sourceRegion: text(),
		destType: text().notNull(),
		destEndpoint: text(),
		destBucketName: text(),
		destAccessKeyId: text(),
		destSecretAccessKey: text(),
		destRegion: text(),
		totalObjects: integer().notNull().default(0),
		processedObjects: integer().notNull().default(0),
		failedObjects: integer().notNull().default(0),
		cursor: integer().notNull().default(0),
		workflowInstanceId: text(),
		lastError: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		completedAt: integer({ mode: 'timestamp_ms' }),
	},
	(table) => [
		index('StorageMigration_organizationId_status_idx').on(
			table.organizationId,
			table.status,
		),
		index('StorageMigration_organizationId_idx').on(table.organizationId),
	],
)

export const OrganizationNote = sqliteTable(
	'OrganizationNote',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		title: text().notNull(),
		content: text().notNull(),
		isPublic: integer({ mode: 'boolean' }).default(true).notNull(),
		priority: text(),
		tags: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		createdById: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		statusId: text().references(() => OrganizationNoteStatus.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		position: real(),
	},
	(table) => [
		index('OrganizationNote_organizationId_statusId_position_idx').on(
			table.organizationId,
			table.statusId,
			table.position,
		),
		index('OrganizationNote_organizationId_updatedAt_idx').on(
			table.organizationId,
			table.updatedAt,
		),
		index('OrganizationNote_createdById_idx').on(table.createdById),
		index('OrganizationNote_organizationId_idx').on(table.organizationId),
	],
)

export const OrganizationNoteStatus = sqliteTable(
	'OrganizationNoteStatus',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		name: text().notNull(),
		color: text().default('#6b7280'),
		position: real(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('OrganizationNoteStatus_organizationId_name_key').on(
			table.organizationId,
			table.name,
		),
		index('OrganizationNoteStatus_organizationId_position_idx').on(
			table.organizationId,
			table.position,
		),
		index('OrganizationNoteStatus_organizationId_idx').on(table.organizationId),
	],
)

export const OrganizationRole = sqliteTable(
	'OrganizationRole',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		name: text().notNull(),
		description: text().default('').notNull(),
		level: integer().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationRole_level_idx').on(table.level),
		uniqueIndex('OrganizationRole_name_key').on(table.name),
	],
)

export const _OrganizationPermissionToRole = sqliteTable(
	'_OrganizationPermissionToRole',
	{
		A: text()
			.notNull()
			.references(() => OrganizationRole.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		B: text()
			.notNull()
			.references(() => Permission.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
	},
	(table) => [
		index('_OrganizationPermissionToRole_B_index').on(table.B),
		uniqueIndex('_OrganizationPermissionToRole_AB_unique').on(table.A, table.B),
	],
)

export const OrganizationInvitation = sqliteTable(
	'OrganizationInvitation',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		email: text().notNull(),
		organizationRoleId: text()
			.notNull()
			.references(() => OrganizationRole.id, {
				onDelete: 'restrict',
				onUpdate: 'cascade',
			}),
		token: text().notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		inviterId: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
	},
	(table) => [
		uniqueIndex('OrganizationInvitation_email_organizationId_key').on(
			table.email,
			table.organizationId,
		),
		index('OrganizationInvitation_organizationRoleId_idx').on(
			table.organizationRoleId,
		),
		index('OrganizationInvitation_organizationId_idx').on(table.organizationId),
		uniqueIndex('OrganizationInvitation_token_key').on(table.token),
	],
)

export const OrganizationInviteLink = sqliteTable(
	'OrganizationInviteLink',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		token: text().notNull(),
		organizationRoleId: text()
			.notNull()
			.references(() => OrganizationRole.id, {
				onDelete: 'restrict',
				onUpdate: 'cascade',
			}),
		isActive: integer({ mode: 'boolean' }).default(true).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		createdById: text()
			.notNull()
			.references(() => User.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
	},
	(table) => [
		uniqueIndex('OrganizationInviteLink_organizationId_createdById_key').on(
			table.organizationId,
			table.createdById,
		),
		index('OrganizationInviteLink_organizationRoleId_idx').on(
			table.organizationRoleId,
		),
		index('OrganizationInviteLink_createdById_idx').on(table.createdById),
		index('OrganizationInviteLink_organizationId_idx').on(table.organizationId),
		uniqueIndex('OrganizationInviteLink_token_key').on(table.token),
	],
)

export const Permission = sqliteTable(
	'Permission',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		action: text().notNull(),
		entity: text().notNull(),
		access: text().notNull(),
		context: text().default('system').notNull(),
		description: text().default('').notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('Permission_action_entity_access_context_key').on(
			table.action,
			table.entity,
			table.access,
			table.context,
		),
	],
)

export const UserOrganization = sqliteTable(
	'UserOrganization',
	{
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		organizationRoleId: text()
			.notNull()
			.references(() => OrganizationRole.id, {
				onDelete: 'restrict',
				onUpdate: 'cascade',
			}),
		active: integer({ mode: 'boolean' }).default(true).notNull(),
		isDefault: integer({ mode: 'boolean' }).default(false).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		department: text(),
	},
	(table) => [
		index('UserOrganization_organizationRoleId_idx').on(
			table.organizationRoleId,
		),
		index('UserOrganization_organizationId_idx').on(table.organizationId),
		index('UserOrganization_userId_idx').on(table.userId),
		primaryKey({
			columns: [table.userId, table.organizationId],
			name: 'UserOrganization_userId_organizationId_pk',
		}),
	],
)

export const ConfigFlag = sqliteTable(
	'ConfigFlag',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		key: text().notNull(),
		value: text({ mode: 'json' }).notNull(),
		level: text().notNull(),
		organizationId: text().references(() => Organization.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		userId: text().references(() => User.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('ConfigFlag_key_level_organizationId_userId_key').on(
			table.key,
			table.level,
			table.organizationId,
			table.userId,
		),
		index('ConfigFlag_userId_idx').on(table.userId),
		index('ConfigFlag_organizationId_idx').on(table.organizationId),
		index('ConfigFlag_level_idx').on(table.level),
		index('ConfigFlag_key_idx').on(table.key),
	],
)

export const RefreshToken = sqliteTable(
	'RefreshToken',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		tokenHash: text().notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		userAgent: text(),
		ipAddress: text(),
		revoked: integer({ mode: 'boolean' }).default(false).notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('RefreshToken_expiresAt_idx').on(table.expiresAt),
		index('RefreshToken_userId_revoked_idx').on(table.userId, table.revoked),
		index('RefreshToken_userId_idx').on(table.userId),
	],
)

export const SSOConfiguration = sqliteTable(
	'SSOConfiguration',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		providerName: text().notNull(),
		issuerUrl: text().notNull(),
		clientId: text().notNull(),
		clientSecret: text().notNull(),
		authorizationUrl: text(),
		tokenUrl: text(),
		userinfoUrl: text(),
		revocationUrl: text(),
		scopes: text().default('openid email profile').notNull(),
		autoDiscovery: integer({ mode: 'boolean' }).default(true).notNull(),
		pkceEnabled: integer({ mode: 'boolean' }).default(true).notNull(),
		autoProvision: integer({ mode: 'boolean' }).default(true).notNull(),
		defaultRole: text().default('member').notNull(),
		attributeMapping: text(),
		isEnabled: integer({ mode: 'boolean' }).default(false).notNull(),
		lastTested: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		requireVerifiedEmail: integer({ mode: 'boolean' }).default(false).notNull(),
		allowedEmailDomains: text(),
		enforceSSOLogin: integer({ mode: 'boolean' }).default(false).notNull(),
	},
	(table) => [
		index('SSOConfiguration_isEnabled_idx').on(table.isEnabled),
		index('SSOConfiguration_organizationId_idx').on(table.organizationId),
		uniqueIndex('SSOConfiguration_organizationId_key').on(table.organizationId),
	],
)

export const SSOSession = sqliteTable(
	'SSOSession',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		sessionId: text()
			.notNull()
			.references(() => Session.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		ssoConfigId: text()
			.notNull()
			.references(() => SSOConfiguration.id, {
				onDelete: 'restrict',
				onUpdate: 'cascade',
			}),
		providerUserId: text().notNull(),
		accessToken: text(),
		refreshToken: text(),
		tokenExpiresAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('SSOSession_providerUserId_idx').on(table.providerUserId),
		index('SSOSession_ssoConfigId_idx').on(table.ssoConfigId),
		uniqueIndex('SSOSession_sessionId_key').on(table.sessionId),
	],
)

export const AuditLog = sqliteTable(
	'AuditLog',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		organizationId: text().references(() => Organization.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		userId: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		action: text().notNull(),
		details: text().notNull(),
		metadata: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		ipAddress: text(),
		userAgent: text(),
		resourceType: text(),
		resourceId: text(),
		targetUserId: text(),
		severity: text().default('info').notNull(),
		retainUntil: integer({ mode: 'timestamp_ms' }),
		archived: integer({ mode: 'boolean' }).default(false).notNull(),
		integrityHash: text(),
	},
	(table) => [
		index('AuditLog_targetUserId_idx').on(table.targetUserId),
		index('AuditLog_archived_retainUntil_idx').on(
			table.archived,
			table.retainUntil,
		),
		index('AuditLog_organizationId_createdAt_idx').on(
			table.organizationId,
			table.createdAt,
		),
		index('AuditLog_resourceType_resourceId_idx').on(
			table.resourceType,
			table.resourceId,
		),
		index('AuditLog_severity_idx').on(table.severity),
		index('AuditLog_createdAt_idx').on(table.createdAt),
		index('AuditLog_action_idx').on(table.action),
		index('AuditLog_userId_idx').on(table.userId),
		index('AuditLog_organizationId_idx').on(table.organizationId),
	],
)

export const AuditLogRetentionPolicy = sqliteTable(
	'AuditLogRetentionPolicy',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		retentionDays: integer().default(365).notNull(),
		hotStorageDays: integer().default(180).notNull(),
		archiveEnabled: integer({ mode: 'boolean' }).default(true).notNull(),
		exportEnabled: integer({ mode: 'boolean' }).default(true).notNull(),
		complianceType: text(),
		immutable: integer({ mode: 'boolean' }).default(true).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('AuditLogRetentionPolicy_organizationId_idx').on(
			table.organizationId,
		),
		uniqueIndex('AuditLogRetentionPolicy_organizationId_key').on(
			table.organizationId,
		),
	],
)

export const MCPAuthorization = sqliteTable(
	'MCPAuthorization',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		clientName: text().notNull(),
		clientId: text().notNull(),
		isActive: integer({ mode: 'boolean' }).default(true).notNull(),
		lastUsedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('MCPAuthorization_userId_organizationId_idx').on(
			table.userId,
			table.organizationId,
		),
		index('MCPAuthorization_clientId_idx').on(table.clientId),
		index('MCPAuthorization_organizationId_idx').on(table.organizationId),
		index('MCPAuthorization_userId_idx').on(table.userId),
		uniqueIndex('MCPAuthorization_clientId_key').on(table.clientId),
	],
)

export const MCPAccessToken = sqliteTable(
	'MCPAccessToken',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		authorizationId: text()
			.notNull()
			.references(() => MCPAuthorization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		tokenHash: text().notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
		ipAddress: text(),
		userAgent: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('MCPAccessToken_expiresAt_idx').on(table.expiresAt),
		index('MCPAccessToken_tokenHash_idx').on(table.tokenHash),
		index('MCPAccessToken_authorizationId_idx').on(table.authorizationId),
		uniqueIndex('MCPAccessToken_tokenHash_key').on(table.tokenHash),
	],
)

export const MCPRefreshToken = sqliteTable(
	'MCPRefreshToken',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		authorizationId: text()
			.notNull()
			.references(() => MCPAuthorization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		tokenHash: text().notNull(),
		revoked: integer({ mode: 'boolean' }).default(false).notNull(),
		revokedAt: integer({ mode: 'timestamp_ms' }),
		expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
		ipAddress: text(),
		userAgent: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('MCPRefreshToken_revoked_idx').on(table.revoked),
		index('MCPRefreshToken_expiresAt_idx').on(table.expiresAt),
		index('MCPRefreshToken_tokenHash_idx').on(table.tokenHash),
		index('MCPRefreshToken_authorizationId_idx').on(table.authorizationId),
		uniqueIndex('MCPRefreshToken_tokenHash_key').on(table.tokenHash),
	],
)

export const WaitlistEntry = sqliteTable(
	'WaitlistEntry',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		points: integer().default(1).notNull(),
		referralCode: text().notNull(),
		hasJoinedDiscord: integer({ mode: 'boolean' }).default(false).notNull(),
		hasEarlyAccess: integer({ mode: 'boolean' }).default(false).notNull(),
		grantedAccessAt: integer({ mode: 'timestamp_ms' }),
		grantedAccessBy: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		referredById: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('WaitlistEntry_grantedAccessBy_idx').on(table.grantedAccessBy),
		index('WaitlistEntry_hasEarlyAccess_idx').on(table.hasEarlyAccess),
		index('WaitlistEntry_points_createdAt_idx').on(
			table.points,
			table.createdAt,
		),
		index('WaitlistEntry_referralCode_idx').on(table.referralCode),
		index('WaitlistEntry_userId_idx').on(table.userId),
		uniqueIndex('WaitlistEntry_referralCode_key').on(table.referralCode),
		uniqueIndex('WaitlistEntry_userId_key').on(table.userId),
		foreignKey(() => ({
			columns: [table.referredById],
			foreignColumns: [table.id],
			name: 'WaitlistEntry_referredById_WaitlistEntry_id_fk',
		}))
			.onUpdate('cascade')
			.onDelete('set null'),
	],
)

export const RateLimitEntry = sqliteTable(
	'RateLimitEntry',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		keyId: text().notNull(),
		keyType: text().notNull(),
		keyValue: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('RateLimitEntry_createdAt_idx').on(table.createdAt),
		index('RateLimitEntry_keyId_createdAt_idx').on(
			table.keyId,
			table.createdAt,
		),
		index('RateLimitEntry_keyId_idx').on(table.keyId),
	],
)

export const MCPClient = sqliteTable(
	'MCPClient',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		clientId: text().notNull(),
		clientName: text().notNull(),
		redirectUris: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('MCPClient_clientId_idx').on(table.clientId),
		uniqueIndex('MCPClient_clientId_key').on(table.clientId),
	],
)

export const BackupCode = sqliteTable(
	'BackupCode',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		codeHash: text().notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		usedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('BackupCode_userId_usedAt_idx').on(table.userId, table.usedAt),
		index('BackupCode_userId_idx').on(table.userId),
	],
)

export const ImpersonationSession = sqliteTable(
	'ImpersonationSession',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		adminUserId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		targetUserId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		ipHash: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [
		index('ImpersonationSession_expiresAt_idx').on(table.expiresAt),
		index('ImpersonationSession_targetUserId_idx').on(table.targetUserId),
		index('ImpersonationSession_adminUserId_idx').on(table.adminUserId),
	],
)

export const DataSubjectRequest = sqliteTable(
	'DataSubjectRequest',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		userId: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		type: text().notNull(),
		status: text().default('requested').notNull(),
		requestedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		processedAt: integer({ mode: 'timestamp_ms' }),
		completedAt: integer({ mode: 'timestamp_ms' }),
		cancelledAt: integer({ mode: 'timestamp_ms' }),
		scheduledFor: integer({ mode: 'timestamp_ms' }),
		executedAt: integer({ mode: 'timestamp_ms' }),
		failureReason: text(),
		metadata: text(),
		ipAddress: text(),
		userAgent: text(),
	},
	(table) => [
		index('DataSubjectRequest_requestedAt_idx').on(table.requestedAt),
		index('DataSubjectRequest_status_scheduledFor_idx').on(
			table.status,
			table.scheduledFor,
		),
		index('DataSubjectRequest_userId_type_status_idx').on(
			table.userId,
			table.type,
			table.status,
		),
	],
)

export const ApiKey = sqliteTable(
	'ApiKey',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		keyHash: text().notNull(),
		keyPrefix: text().notNull(),
		name: text().notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		lastUsedAt: integer({ mode: 'timestamp_ms' }),
		expiresAt: integer({ mode: 'timestamp_ms' }),
	},
	(table) => [
		index('ApiKey_keyHash_idx').on(table.keyHash),
		index('ApiKey_organizationId_idx').on(table.organizationId),
		index('ApiKey_userId_idx').on(table.userId),
		uniqueIndex('ApiKey_keyHash_key').on(table.keyHash),
	],
)

export const OrganizationAnnouncement = sqliteTable(
	'OrganizationAnnouncement',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		content: text().notNull(),
		type: text().default('info').notNull(),
		isEnabled: integer({ mode: 'boolean' }).default(true).notNull(),
		linkUrl: text(),
		linkLabel: text(),
		linkNewTab: integer({ mode: 'boolean' }).default(true).notNull(),
		position: real(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationAnnouncement_organizationId_isEnabled_position_idx').on(
			table.organizationId,
			table.isEnabled,
			table.position,
		),
		index('OrganizationAnnouncement_organizationId_idx').on(
			table.organizationId,
		),
	],
)

export const OrganizationSiteAsset = sqliteTable(
	'OrganizationSiteAsset',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		type: text().notNull(),
		objectKey: text().notNull(),
		width: integer(),
		height: integer(),
		mimeType: text(),
		status: text().default('processing').notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('OrganizationSiteAsset_organizationId_type_key').on(
			table.organizationId,
			table.type,
		),
		index('OrganizationSiteAsset_organizationId_type_idx').on(
			table.organizationId,
			table.type,
		),
		index('OrganizationSiteAsset_organizationId_idx').on(table.organizationId),
	],
)

export const WebsitePage = sqliteTable(
	'WebsitePage',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		title: text().notNull(),
		slug: text().notNull(),
		status: text().default('draft').notNull(),
		template: text().default('blank').notNull(),
		isHomePage: integer({ mode: 'boolean' }).default(false).notNull(),
		position: real(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		createdById: text()
			.notNull()
			.references(() => User.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
		seoTitle: text(),
		seoDescription: text(),
		seoImageUrl: text(),
		seoNoIndex: integer({ mode: 'boolean' }).default(false).notNull(),
		publishedData: text(),
	},
	(table) => [
		uniqueIndex('WebsitePage_organizationId_slug_key').on(
			table.organizationId,
			table.slug,
		),
		index('WebsitePage_organizationId_status_idx').on(
			table.organizationId,
			table.status,
		),
		index('WebsitePage_organizationId_idx').on(table.organizationId),
	],
)

export const WebsitePageSection = sqliteTable(
	'WebsitePageSection',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		pageId: text()
			.notNull()
			.references(() => WebsitePage.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		type: text().notNull(),
		config: text().default('{}').notNull(),
		position: real().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('WebsitePageSection_pageId_position_idx').on(
			table.pageId,
			table.position,
		),
		index('WebsitePageSection_pageId_idx').on(table.pageId),
	],
)

export const WebsiteRedirect = sqliteTable(
	'WebsiteRedirect',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		fromPath: text().notNull(),
		toPath: text().notNull(),
		statusCode: integer().default(301).notNull(),
		isEnabled: integer({ mode: 'boolean' }).default(true).notNull(),
		hitCount: integer().default(0).notNull(),
		lastTriggeredAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('WebsiteRedirect_organizationId_fromPath_key').on(
			table.organizationId,
			table.fromPath,
		),
		index('WebsiteRedirect_organizationId_idx').on(table.organizationId),
		index('WebsiteRedirect_organizationId_isEnabled_idx').on(
			table.organizationId,
			table.isEnabled,
		),
	],
)

export const WebsiteNotFoundLog = sqliteTable(
	'WebsiteNotFoundLog',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		path: text().notNull(),
		hitCount: integer().default(1).notNull(),
		firstHitAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		lastHitAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		lastReferrer: text(),
		lastUserAgent: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('WebsiteNotFoundLog_organizationId_path_key').on(
			table.organizationId,
			table.path,
		),
		index('WebsiteNotFoundLog_organizationId_lastHitAt_idx').on(
			table.organizationId,
			table.lastHitAt,
		),
		index('WebsiteNotFoundLog_organizationId_hitCount_idx').on(
			table.organizationId,
			table.hitCount,
		),
		index('WebsiteNotFoundLog_organizationId_idx').on(table.organizationId),
	],
)

export const NotificationPreference = sqliteTable(
	'NotificationPreference',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		workflow: text().notNull(),
		email: integer({ mode: 'boolean' }).default(true).notNull(),
		inApp: integer({ mode: 'boolean' }).default(true).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('NotificationPreference_userId_organizationId_workflow_key').on(
			table.userId,
			table.organizationId,
			table.workflow,
		),
	],
)

export const Notification = sqliteTable(
	'Notification',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		type: text().notNull(),
		entityId: text().notNull(),
		payload: text().notNull(),
		isRead: integer({ mode: 'boolean' }).default(false).notNull(),
		isSeen: integer({ mode: 'boolean' }).default(false).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('Notification_userId_organizationId_type_entityId_key').on(
			table.userId,
			table.organizationId,
			table.type,
			table.entityId,
		),
		index('Notification_userId_updatedAt_idx').on(
			table.userId,
			table.updatedAt,
		),
		index('Notification_userId_organizationId_updatedAt_idx').on(
			table.userId,
			table.organizationId,
			table.updatedAt,
		),
		index('Notification_userId_createdAt_idx').on(
			table.userId,
			table.createdAt,
		),
		index('Notification_userId_isRead_idx').on(table.userId, table.isRead),
	],
)

export const Organization = sqliteTable(
	'Organization',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		name: text().notNull(),
		slug: text().notNull(),
		description: text(),
		active: integer({ mode: 'boolean' }).default(true).notNull(),
		hasProvisionedDb: integer({ mode: 'boolean' }).default(false).notNull(),
		dataRegion: text().default('us').notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
		planName: text(),
		stripeCustomerId: text(),
		stripeProductId: text(),
		stripeSubscriptionId: text(),
		subscriptionStatus: text(),
		size: text(),
		verifiedDomain: text(),
		sitePublished: integer({ mode: 'boolean' }).default(false).notNull(),
		customDomain: text(),
		customDomainStatus: text(),
		cloudflareHostnameId: text(),
		siteTheme: text(),
		siteLocales: text(),
		siteDefaultLocale: text().default('en'),
		siteIconKey: text(),
		siteHeaderConfig: text(),
		siteFooterConfig: text(),
		stripeConnectAccountId: text(),
		stripeConnectChargesEnabled: integer({ mode: 'boolean' })
			.default(false)
			.notNull(),
		stripeConnectPayoutsEnabled: integer({ mode: 'boolean' })
			.default(false)
			.notNull(),
		checkoutSubEntityId: text(),
		checkoutChargesEnabled: integer({ mode: 'boolean' })
			.default(false)
			.notNull(),
		checkoutPayoutsEnabled: integer({ mode: 'boolean' })
			.default(false)
			.notNull(),
		shopPaymentProvider: text().default('stripe').notNull(),
		polarProductId: text(),
		shopProductName: text(),
		shopProductDescription: text(),
		shopProductPriceCents: integer(),
		shopEnabled: integer({ mode: 'boolean' }).default(false).notNull(),
		facebookPixelId: text(),
		googleTagManagerId: text(),
		googleAnalyticsId: text(),
		tiktokPixelId: text(),
	},
	(table) => [
		uniqueIndex('Organization_customDomain_key').on(table.customDomain),
		uniqueIndex('Organization_slug_key').on(table.slug),
	],
)

export const PlatformMarketingCampaign = sqliteTable(
	'PlatformMarketingCampaign',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		name: text().notNull(),
		channel: text().notNull(),
		subject: text(),
		content: text().notNull(),
		/** JSON array of email blocks (source of truth for the email designer). */
		contentBlocks: text(),
		/** Design-time rendered HTML for email campaigns. */
		contentHtml: text(),
		status: text().default('Draft').notNull(),
		audience: text().default('all_operators').notNull(),
		targetOrganizationId: text().references(() => Organization.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		targetAudienceCount: integer().default(0).notNull(),
		segmentationRules: text(),
		scheduledAt: integer({ mode: 'timestamp_ms' }),
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('PlatformMarketingCampaign_status_idx').on(table.status),
		index('PlatformMarketingCampaign_createdAt_idx').on(table.createdAt),
	],
)

export const PlatformMarketingMessage = sqliteTable(
	'PlatformMarketingMessage',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		campaignId: text()
			.notNull()
			.references(() => PlatformMarketingCampaign.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		status: text().default('Processing').notNull(),
		sentAt: integer({ mode: 'timestamp_ms' }),
		openedAt: integer({ mode: 'timestamp_ms' }),
		clickedAt: integer({ mode: 'timestamp_ms' }),
		providerMessageId: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('PlatformMarketingMessage_campaignId_idx').on(table.campaignId),
		index('PlatformMarketingMessage_userId_idx').on(table.userId),
		index('PlatformMarketingMessage_providerMessageId_idx').on(
			table.providerMessageId,
		),
	],
)

export const PlatformMarketingJourney = sqliteTable(
	'PlatformMarketingJourney',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		name: text().notNull(),
		description: text(),
		status: text().default('draft').notNull(),
		triggerType: text().notNull(),
		triggerConfig: text(),
		nodes: text(),
		edges: text(),
		graphJson: text(),
		version: integer().default(1).notNull(),
		publishedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('PlatformMarketingJourney_status_idx').on(table.status),
		index('PlatformMarketingJourney_triggerType_idx').on(table.triggerType),
	],
)

export const PlatformJourneyRun = sqliteTable(
	'PlatformJourneyRun',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		journeyId: text()
			.notNull()
			.references(() => PlatformMarketingJourney.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		organizationId: text().references(() => Organization.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		status: text().default('running').notNull(),
		currentNodeId: text(),
		currentStepNodeId: text(),
		triggerEvent: text(),
		contextData: text(),
		errorMessage: text(),
		startedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		completedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('PlatformJourneyRun_journeyId_status_idx').on(
			table.journeyId,
			table.status,
		),
		index('PlatformJourneyRun_userId_idx').on(table.userId),
	],
)

export const PlatformJourneyStepExecution = sqliteTable(
	'PlatformJourneyStepExecution',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		runId: text()
			.notNull()
			.references(() => PlatformJourneyRun.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		nodeId: text().notNull(),
		nodeType: text().notNull(),
		status: text().default('pending').notNull(),
		attempt: integer().default(0).notNull(),
		executionDetails: text(),
		errorMessage: text(),
		executedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('PlatformJourneyStepExecution_runId_idx').on(table.runId),
		uniqueIndex('PlatformJourneyStepExecution_runId_nodeId_key').on(
			table.runId,
			table.nodeId,
		),
	],
)

export const SavedReport = sqliteTable(
	'SavedReport',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		scope: text().notNull(),
		organizationId: text().references(() => Organization.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		createdById: text()
			.notNull()
			.references(() => User.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		title: text().notNull(),
		notes: text().default('').notNull(),
		definition: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('SavedReport_organizationId_updatedAt_idx').on(
			table.organizationId,
			table.updatedAt,
		),
		index('SavedReport_scope_updatedAt_idx').on(table.scope, table.updatedAt),
		index('SavedReport_createdById_idx').on(table.createdById),
	],
)
