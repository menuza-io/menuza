/**
 * Control-plane SQLite schema for Drizzle.
 *
 * DATETIME columns use millisecond timestamps and BOOLEAN columns use 0/1
 * integers. Schema changes: `drizzle-kit generate`, then `tsx src/migrate.ts`.
 */
import { createId } from '@paralleldrive/cuid2'
import { sql } from 'drizzle-orm'
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
		organizationLocationId: text().references(() => OrganizationLocation.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		providerName: text().notNull(),
		providerType: text().notNull(),
		/** DoorDash store id / Clover merchant id for cross-org uniqueness. */
		externalStoreId: text(),
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
		index('Integration_organizationId_idx').on(table.organizationId),
		index('Integration_organizationLocationId_idx').on(
			table.organizationLocationId,
		),
		uniqueIndex('Integration_org_provider_orgwide_key')
			.on(table.organizationId, table.providerName)
			.where(sql`${table.organizationLocationId} IS NULL`),
		uniqueIndex('Integration_location_provider_key')
			.on(table.organizationLocationId, table.providerName)
			.where(sql`${table.organizationLocationId} IS NOT NULL`),
		uniqueIndex('Integration_provider_external_store_key').on(
			table.providerName,
			table.externalStoreId,
		),
	],
)

export const IntegrationOAuthNonce = sqliteTable('IntegrationOAuthNonce', {
	nonce: text().primaryKey().notNull(),
	expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
	consumedAt: integer({ mode: 'timestamp_ms' }),
})

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
		/**
		 * Launch checklist rows (`launch.checklist`) are per location and shared
		 * by every member: `userId` is who last changed the row. Template
		 * onboarding rows leave it null and stay per user.
		 */
		locationId: text().references(() => OrganizationLocation.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		/** An optional launch step the operator skipped, with an optional reason. */
		skippedAt: integer({ mode: 'timestamp_ms' }),
		skipReason: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		// One template row per user and step; one launch row per location and
		// step (migration 0047 split the old unique index in two).
		uniqueIndex('OnboardingStepProgress_userId_organizationId_stepId_key')
			.on(table.userId, table.organizationId, table.stepId)
			.where(sql`${table.locationId} IS NULL`),
		uniqueIndex('OnboardingStepProgress_organizationId_locationId_stepId_key')
			.on(table.organizationId, table.locationId, table.stepId)
			.where(sql`${table.locationId} IS NOT NULL`),
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

/**
 * The objects a storage migration moves, listed once when it starts. Batches
 * take the next pending items, so media added or removed while it runs never
 * shifts which object is next.
 */
export const StorageMigrationItem = sqliteTable(
	'StorageMigrationItem',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		migrationId: text()
			.notNull()
			.references(() => StorageMigration.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		objectKey: text().notNull(),
		contentType: text().notNull(),
		/** 'pending' | 'done' | 'failed' */
		status: text().notNull().default('pending'),
		attempts: integer().notNull().default(0),
		lastError: text(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('StorageMigrationItem_migrationId_objectKey_key').on(
			table.migrationId,
			table.objectKey,
		),
		index('StorageMigrationItem_migrationId_status_idx').on(
			table.migrationId,
			table.status,
		),
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
		// NULL identifies a shared platform role. A non-null value makes this a
		// tenant-owned role, which may only be assigned within that organization.
		organizationId: text().references(() => Organization.id, {
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
		index('OrganizationRole_level_idx').on(table.level),
		index('OrganizationRole_organizationId_idx').on(table.organizationId),
		uniqueIndex('OrganizationRole_shared_name_key')
			.on(sql`lower(${table.name})`)
			.where(sql`${table.organizationId} IS NULL`),
		uniqueIndex('OrganizationRole_organizationId_name_key')
			.on(table.organizationId, sql`lower(${table.name})`)
			.where(sql`${table.organizationId} IS NOT NULL`),
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
		// Cascade so deleting an organization (which cascades to its custom
		// roles) is not blocked by a pending invitation. Deleting a role that
		// still has invitations is refused in code instead (App
		// settings/roles, Admin roles).
		organizationRoleId: text()
			.notNull()
			.references(() => OrganizationRole.id, {
				onDelete: 'cascade',
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
		// Opaque id of a regional staff row this invitation will link to once
		// accepted. Deliberately no foreign key: staff records live in the
		// regional tenant database, never in the control plane.
		staffMemberId: text(),
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
		// A link is personal: it goes when its creator's account is deleted.
		createdById: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
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
		// Which locations this member's staffing access covers: 'all' (every
		// location, the default) or 'selected' (only the UserOrganizationLocation
		// rows; none means no staffing access). Permissions elsewhere stay org-wide.
		locationScope: text().default('all').notNull(),
		/** Gross or net sales for reports and the dashboard Today tile (#331). */
		reportSalesBasis: text().default('net').notNull(),
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
		// NULL organization or user ids (system and organization flags) are
		// compared as '' so they are covered too: SQLite treats NULLs in a
		// plain unique index as distinct.
		uniqueIndex('ConfigFlag_key_level_scope_key').on(
			table.key,
			table.level,
			sql`coalesce(${table.organizationId}, '')`,
			sql`coalesce(${table.userId}, '')`,
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
		// Set when the token was rotated (not signed out): the id of its
		// successor. No foreign key, so cleaning up either row is independent.
		replacedById: text(),
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

/**
 * Which identity-provider account (subject) signs in as which user, per SSO
 * configuration. Created on a user's first SSO sign-in; afterwards SSO matches
 * on this pair, not on the email the IdP sends, so an IdP cannot sign in as
 * another person by asserting their address.
 *
 * Scoped to the configuration, not the issuer: IdPs such as Entra ID issue a
 * pairwise `sub` per application (client id), so two organizations on one
 * tenant, or one organization that replaces its app registration, see
 * different subjects for the same person. A trigger (migration 0028) deletes a
 * configuration's links when its client id or issuer changes, and Admin can
 * reset one user's link.
 */
export const SSOIdentity = sqliteTable(
	'SSOIdentity',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		ssoConfigId: text()
			.notNull()
			.references(() => SSOConfiguration.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		issuer: text().notNull(),
		subject: text().notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('SSOIdentity_ssoConfigId_subject_key').on(
			table.ssoConfigId,
			table.subject,
		),
		uniqueIndex('SSOIdentity_ssoConfigId_userId_key').on(
			table.ssoConfigId,
			table.userId,
		),
		index('SSOIdentity_userId_idx').on(table.userId),
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
				onDelete: 'cascade',
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
		// One active impersonation per admin, enforced by the database so two
		// concurrent starts cannot both insert.
		uniqueIndex('ImpersonationSession_adminUserId_key').on(table.adminUserId),
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

/**
 * Promotional popups (#132). Content only, no visitor data: signups go from the
 * browser to the regional tenant-api. Published popups reach the public site
 * with the coupon resolved and re-checked on every request, so a coupon that
 * expires or is switched off stops the popup without an edit here.
 */
export const SitePopup = sqliteTable(
	'SitePopup',
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
		/** The operator's own label; never shown to visitors. */
		name: text().notNull(),
		status: text({ enum: ['draft', 'published'] })
			.default('draft')
			.notNull(),
		/** Localized JSON strings (`{"en":"…","ar":"…"}`), like every site text. */
		title: text().notNull().default(''),
		body: text().notNull().default(''),
		buttonLabel: text().notNull().default(''),
		/** Where the button goes when there is no coupon (a site path or https URL). */
		buttonUrl: text(),
		imageUrl: text(),
		/** An optional online coupon; the popup stops showing if it stops working. */
		discountId: text().references(() => Discount.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		trigger: text({ enum: ['delay', 'scroll', 'exit'] })
			.default('delay')
			.notNull(),
		/** Seconds for `delay`, percent scrolled for `scroll`; unused for `exit`. */
		triggerValue: integer().default(5).notNull(),
		frequency: text({ enum: ['session', 'day', 'week', 'ever'] })
			.default('day')
			.notNull(),
		/** JSON array: `["all"]` or any of `home`, `menu`, `other`. */
		pages: text().default('["all"]').notNull(),
		startsAt: integer({ mode: 'timestamp_ms' }),
		endsAt: integer({ mode: 'timestamp_ms' }),
		/** Email or phone signup shown in the popup; the contact stays regional. */
		captureContact: text({ enum: ['none', 'email', 'phone'] })
			.default('none')
			.notNull(),
		/** Localized wording of the unchecked consent checkbox. */
		consentText: text().notNull().default(''),
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
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
		index('SitePopup_organizationId_status_idx').on(
			table.organizationId,
			table.status,
		),
		index('SitePopup_discountId_idx').on(table.discountId),
	],
)

/**
 * A/B tests of one section of one page (#338). The original is the live
 * section (variant `a`); `variantConfig` is the section config of variant `b`.
 * Only one test runs per page. Visitors' variants live in their browsers; the
 * region keeps counts per arm (`site_events_daily.variant`), never a visitor.
 */
export const SiteExperiment = sqliteTable(
	'SiteExperiment',
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
		pageId: text()
			.notNull()
			.references(() => WebsitePage.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		sectionId: text().notNull(),
		name: text().notNull(),
		status: text({ enum: ['running', 'ended', 'applied'] })
			.default('running')
			.notNull(),
		/** The section config JSON of variant B (localized strings kept). */
		variantConfig: text().notNull(),
		startedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		/** 60 days after the start; the test ends by itself then. */
		expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
		endedAt: integer({ mode: 'timestamp_ms' }),
		endReason: text({
			enum: ['manual', 'applied', 'expired', 'visitor_cap'],
		}),
		/** The arm applied or declared best when the test ended. */
		winner: text({ enum: ['a', 'b'] }),
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
		index('SiteExperiment_organizationId_status_idx').on(
			table.organizationId,
			table.status,
		),
		// One running test per page, whatever the section.
		uniqueIndex('SiteExperiment_pageId_running_key')
			.on(table.pageId)
			.where(sql`${table.status} = 'running'`),
	],
)

/**
 * Batching of form response emails (#142): at most one email per form per
 * member every 10 minutes. `pendingCount` holds responses that arrived inside
 * the window and goes out in the next email ("3 new responses"). Ids and
 * counts only.
 */
export const FormAlertDigest = sqliteTable(
	'FormAlertDigest',
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
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		/** The regional form id (opaque). */
		formId: text().notNull(),
		lastEmailedAt: integer({ mode: 'timestamp_ms' }),
		pendingCount: integer().default(0).notNull(),
		/** The form name as of the last response, for the batched email. */
		formName: text().notNull().default(''),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('FormAlertDigest_organizationId_userId_formId_key').on(
			table.organizationId,
			table.userId,
			table.formId,
		),
		index('FormAlertDigest_pending_idx').on(table.pendingCount),
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
		/**
		 * Show window (#238), UTC. Both null behaves as before: shown while
		 * enabled. The public site compares these with the request time.
		 */
		startsAt: integer({ mode: 'timestamp_ms' }),
		endsAt: integer({ mode: 'timestamp_ms' }),
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

/**
 * Team chat channels. This table is the source of truth for *who may see a
 * channel*; message content lives in the per-organization `ChatOrg` Durable
 * Object. `access` is `everyone` (every active member) or `restricted`
 * (members whose role is in `OrganizationChatChannelRole`, plus anyone in
 * `OrganizationChatChannelMember`).
 */
export const OrganizationChatChannel = sqliteTable(
	'OrganizationChatChannel',
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
		description: text().default('').notNull(),
		access: text({ enum: ['everyone', 'restricted'] })
			.default('everyone')
			.notNull(),
		kind: text({ enum: ['channel', 'dm', 'group'] })
			.default('channel')
			.notNull(),
		/** Stable key for a 1:1 DM (`userA:userB`, sorted). */
		dmPairKey: text(),
		showHistoryToNewMembers: integer({ mode: 'boolean' })
			.default(false)
			.notNull(),
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
		index('OrganizationChatChannel_organizationId_idx').on(
			table.organizationId,
		),
		uniqueIndex('OrganizationChatChannel_organizationId_name_key')
			.on(table.organizationId, sql`lower(${table.name})`)
			.where(sql`${table.kind} = 'channel'`),
		uniqueIndex('OrganizationChatChannel_organizationId_dmPairKey_key').on(
			table.organizationId,
			table.dmPairKey,
		),
	],
)

export const OrganizationChatChannelRole = sqliteTable(
	'OrganizationChatChannelRole',
	{
		channelId: text()
			.notNull()
			.references(() => OrganizationChatChannel.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		organizationRoleId: text()
			.notNull()
			.references(() => OrganizationRole.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
	},
	(table) => [
		primaryKey({
			columns: [table.channelId, table.organizationRoleId],
			name: 'OrganizationChatChannelRole_channelId_organizationRoleId_pk',
		}),
		index('OrganizationChatChannelRole_organizationRoleId_idx').on(
			table.organizationRoleId,
		),
	],
)

export const OrganizationChatChannelMember = sqliteTable(
	'OrganizationChatChannelMember',
	{
		channelId: text()
			.notNull()
			.references(() => OrganizationChatChannel.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		joinedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.channelId, table.userId],
			name: 'OrganizationChatChannelMember_channelId_userId_pk',
		}),
		index('OrganizationChatChannelMember_userId_idx').on(table.userId),
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

export const OrganizationMediaAsset = sqliteTable(
	'OrganizationMediaAsset',
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
		objectKey: text().notNull(),
		storageScope: text().default('organization').notNull(),
		mimeType: text().notNull(),
		fileName: text(),
		fileSize: integer(),
		width: integer(),
		height: integer(),
		altText: text(),
		caption: text(),
		source: text().default('library').notNull(),
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
		uniqueIndex('OrganizationMediaAsset_organizationId_objectKey_key').on(
			table.organizationId,
			table.objectKey,
		),
		index('OrganizationMediaAsset_organizationId_createdAt_idx').on(
			table.organizationId,
			table.createdAt,
		),
		index('OrganizationMediaAsset_organizationId_mimeType_idx').on(
			table.organizationId,
			table.mimeType,
		),
		index('OrganizationMediaAsset_createdById_idx').on(table.createdById),
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
		// Null once the author's account is deleted: the page belongs to the
		// organization.
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		seoTitle: text(),
		seoDescription: text(),
		seoImageUrl: text(),
		seoNoIndex: integer({ mode: 'boolean' }).default(false).notNull(),
		publishedData: text(),
		/**
		 * Which generated legal page this is (#89, #260): `privacy`, `terms`,
		 * `cookies` or `accessibility`. Null for every other page.
		 */
		legalKind: text(),
		/** The template version the page was last generated from. */
		legalTemplateVersion: integer(),
		/**
		 * Hash of the sections as generated. A page whose current sections hash
		 * differently was edited by the operator and is never regenerated
		 * without a diff and a confirm.
		 */
		legalGeneratedHash: text(),
		/**
		 * Set to `ai` when "Create my site with AI" wrote the page (#141).
		 * Cleared when the operator edits or publishes it.
		 */
		generatedBy: text(),
	},
	(table) => [
		uniqueIndex('WebsitePage_organizationId_legalKind_key')
			.on(table.organizationId, table.legalKind)
			.where(sql`${table.legalKind} IS NOT NULL`),
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
		/**
		 * Who made it (#88): `manual` (Website, Redirects), `page_rename` or
		 * `page_delete` (added automatically, shown with a badge), or
		 * `location_rename` (a location page's address changed, #137).
		 */
		source: text().default('manual').notNull(),
		/** The page an automatic redirect was made for; null once it is gone. */
		pageId: text().references(() => WebsitePage.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
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

/** One AI site generation, for the five-a-day limit (#141). No page content. */
export const WebsiteSiteGeneration = sqliteTable(
	'WebsiteSiteGeneration',
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
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('WebsiteSiteGeneration_organizationId_createdAt_idx').on(
			table.organizationId,
			table.createdAt,
		),
	],
)

/** A website import run (#140). Extracted content is the business's public site. */
export const WebsiteImport = sqliteTable(
	'WebsiteImport',
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
		sourceUrl: text().notNull(),
		status: text().default('found').notNull(),
		stats: text(),
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
		index('WebsiteImport_organizationId_idx').on(table.organizationId),
	],
)

export const WebsiteImportPage = sqliteTable(
	'WebsiteImportPage',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		importId: text()
			.notNull()
			.references(() => WebsiteImport.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		url: text().notNull(),
		title: text().default('').notNull(),
		extracted: text(),
		proposedSections: text(),
		status: text().default('found').notNull(),
		skipReason: text(),
		pageId: text().references(() => WebsitePage.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		redirectTo: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('WebsiteImportPage_importId_idx').on(table.importId),
		uniqueIndex('WebsiteImportPage_importId_url_key').on(
			table.importId,
			table.url,
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

/**
 * One immutable published version of a page, of the site header and footer
 * (`chrome`) or of the site theme (#85). Every publish writes one; restoring
 * copies a version into the draft and never publishes. `pageId` has no foreign
 * key on purpose: the versions of a deleted page are kept for 30 days
 * (`deletedAt` marks them) so it can be brought back, then purged. At most 50
 * are kept per page and per kind, never the live (newest) one.
 */
export const WebsiteVersion = sqliteTable(
	'WebsiteVersion',
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
		/** Null for `chrome` and `theme`. */
		pageId: text(),
		/** `page`, `chrome` or `theme`. */
		kind: text().notNull(),
		/** The page's title and slug when it was published (shown after deletion). */
		title: text(),
		slug: text(),
		/**
		 * JSON. Page: the sections array the site serves. Chrome:
		 * `{ header, footer }` (config strings). Theme: the theme config string.
		 */
		snapshot: text().notNull(),
		contentHash: text().notNull(),
		/** JSON counts of what changed against the version before it. */
		summary: text(),
		publishedById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		publishedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		/** The version this one was restored from, when its draft came from one. */
		restoredFromId: text(),
		/** Set when the page was deleted; the purge job uses it. */
		deletedAt: integer({ mode: 'timestamp_ms' }),
	},
	(table) => [
		index('WebsiteVersion_organizationId_pageId_publishedAt_idx').on(
			table.organizationId,
			table.pageId,
			table.publishedAt,
		),
		index('WebsiteVersion_organizationId_kind_publishedAt_idx').on(
			table.organizationId,
			table.kind,
			table.publishedAt,
		),
		index('WebsiteVersion_deletedAt_idx').on(table.deletedAt),
	],
)

/**
 * A page, or the site header, footer and theme, set to go live later (#180).
 * `snapshot` is the draft as it was when scheduled, in the `WebsiteVersion`
 * snapshot format, so edits made afterwards never ride along. One active
 * schedule per page and one for the site design (`scopeKey` is the page id or
 * `site`). A caller claims a due row by moving `scheduled` to `running`.
 */
export const WebsiteScheduledPublish = sqliteTable(
	'WebsiteScheduledPublish',
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
		pageId: text().references(() => WebsitePage.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		scopeKey: text().notNull(),
		/** `page` or `site`. */
		kind: text().notNull(),
		snapshot: text().notNull(),
		runAt: integer({ mode: 'timestamp_ms' }).notNull(),
		/** `scheduled`, `running`, `done`, `cancelled` or `failed`. */
		status: text().default('scheduled').notNull(),
		attempts: integer().default(0).notNull(),
		lastError: text(),
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		claimedAt: integer({ mode: 'timestamp_ms' }),
		completedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('WebsiteScheduledPublish_active_scope_key')
			.on(table.organizationId, table.scopeKey)
			.where(sql`${table.status} IN ('scheduled', 'running')`),
		index('WebsiteScheduledPublish_status_runAt_idx').on(
			table.status,
			table.runAt,
		),
		index('WebsiteScheduledPublish_organizationId_idx').on(
			table.organizationId,
		),
	],
)

/**
 * A host a restaurant's site is served on (#139): the primary, or a redirecting
 * extra (the other form of the primary, an old domain). One row per host, unique
 * across organizations. `Organization.customDomain` stays the denormalized
 * primary host for one release; every public lookup reads both.
 * `method` is how the host reaches us: `cname` (the operator adds records),
 * `nameservers` or `registered` (a `ManagedDomain` zone holds them).
 * `verification` is the ownership and certificate records Cloudflare asked
 * for; `checks` the last per-record DNS result. Operator data only.
 */
export const SiteDomain = sqliteTable(
	'SiteDomain',
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
		hostname: text().notNull(),
		isPrimary: integer({ mode: 'boolean' }).default(false).notNull(),
		managedDomainId: text().references(() => ManagedDomain.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		method: text().default('cname').notNull(),
		cloudflareHostnameId: text(),
		/** `pending`, `active`, `moved`, `blocked`, `error` or `expired`. */
		status: text().default('pending').notNull(),
		sslStatus: text(),
		ownershipStatus: text(),
		verification: text(),
		checks: text(),
		lastError: text(),
		pendingSince: integer({ mode: 'timestamp_ms' }),
		lastCheckedAt: integer({ mode: 'timestamp_ms' }),
		/** The "still not connected" email after 7 days pending. */
		reminderSentAt: integer({ mode: 'timestamp_ms' }),
		/** The "your domain is live" notice, sent once. */
		liveNotifiedAt: integer({ mode: 'timestamp_ms' }),
		addedById: text().references(() => User.id, {
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
		uniqueIndex('SiteDomain_hostname_key').on(table.hostname),
		uniqueIndex('SiteDomain_primary_key')
			.on(table.organizationId)
			.where(sql`${table.isPrimary} = 1`),
		index('SiteDomain_organizationId_idx').on(table.organizationId),
		index('SiteDomain_status_pendingSince_idx').on(
			table.status,
			table.pendingSince,
		),
		index('SiteDomain_managedDomainId_idx').on(table.managedDomainId),
	],
)

/**
 * A domain whose DNS Menuza hosts (#283) or that Menuza registered (#183): the
 * one zone model every domain feature shares (records, buying, forwarding).
 * `source` is `nameservers` (the operator moved an existing domain),
 * `registered` or `transferred`. The zone lives at the DNS provider (`zoneId`);
 * `scan` is what the pre-move scan found; `registrantContact` is the business
 * contact, encrypted with INTEGRATION_ENCRYPTION_KEY. Operator data, no guest
 * PII.
 */
export const ManagedDomain = sqliteTable(
	'ManagedDomain',
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
		fqdn: text().notNull(),
		source: text().default('nameservers').notNull(),
		zoneProvider: text(),
		zoneId: text(),
		nameservers: text(),
		/** `pending` (move not seen yet), `active`, `moved` (left again) or `failed`. */
		zoneStatus: text().default('pending').notNull(),
		nsPendingSince: integer({ mode: 'timestamp_ms' }),
		nsCheckedAt: integer({ mode: 'timestamp_ms' }),
		nsVerifiedAt: integer({ mode: 'timestamp_ms' }),
		scan: text(),
		/** The operator typed the confirmation for a move that might lose mail. */
		emailRiskConfirmedAt: integer({ mode: 'timestamp_ms' }),
		registrar: text(),
		registrarDomainId: text(),
		/** `none`, `pending`, `registering`, `active`, `failed`, `transfer_pending`, `transferred_out`, `expired`. */
		registrationStatus: text().default('none').notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }),
		autoRenew: integer({ mode: 'boolean' }).default(true).notNull(),
		locked: integer({ mode: 'boolean' }).default(true).notNull(),
		privacy: integer({ mode: 'boolean' }).default(true).notNull(),
		registrantContact: text(),
		registrantEmailConfirmedAt: integer({ mode: 'timestamp_ms' }),
		/** Renewal reminders already sent (`{"30":ts,"7":ts}`) for the current term. */
		reminders: text(),
		renewalFailedSince: integer({ mode: 'timestamp_ms' }),
		renewalAttemptedAt: integer({ mode: 'timestamp_ms' }),
		lastJobId: text(),
		emailForwardingEnabledAt: integer({ mode: 'timestamp_ms' }),
		/** Confirmed in words: turning forwarding on cuts off the mail provider. */
		emailForwardingMxConfirmedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('ManagedDomain_fqdn_key').on(table.fqdn),
		index('ManagedDomain_organizationId_idx').on(table.organizationId),
		index('ManagedDomain_zoneStatus_idx').on(table.zoneStatus),
		index('ManagedDomain_registrationStatus_expiresAt_idx').on(
			table.registrationStatus,
			table.expiresAt,
		),
	],
)

/**
 * One DNS record of a managed zone (#283). `managedBy` marks records Menuza
 * writes for the site, email forwarding or sending: those are read-only to the
 * operator. `name` is fully qualified. Every change is also an audit entry.
 */
export const DomainRecord = sqliteTable(
	'DomainRecord',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		managedDomainId: text()
			.notNull()
			.references(() => ManagedDomain.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		type: text().notNull(),
		name: text().notNull(),
		content: text().notNull(),
		ttl: integer().default(1).notNull(),
		priority: integer(),
		proxied: integer({ mode: 'boolean' }).default(false).notNull(),
		/** `site`, `email_forwarding`, `email_sending`, `registrar`; null is the operator's. */
		managedBy: text(),
		/** `imported`, `user` or `managed`. */
		source: text().default('user').notNull(),
		providerRecordId: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('DomainRecord_managedDomainId_idx').on(table.managedDomainId),
	],
)

/**
 * A background step of a domain (#183): `register`, `transfer_in`, `renew`,
 * `transfer_out`. Idempotent by `idempotencyKey`; `step` is what the progress
 * screen shows; `error` is a code, never a provider message with contact data.
 */
export const DomainJob = sqliteTable(
	'DomainJob',
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
		managedDomainId: text().references(() => ManagedDomain.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		kind: text().notNull(),
		/** `queued`, `running`, `succeeded`, `failed` or `cancelled`. */
		status: text().default('queued').notNull(),
		step: text(),
		attempts: integer().default(0).notNull(),
		error: text(),
		idempotencyKey: text().notNull(),
		runAfter: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		params: text(),
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		completedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('DomainJob_idempotencyKey_key').on(table.idempotencyKey),
		index('DomainJob_status_runAfter_idx').on(table.status, table.runAfter),
		index('DomainJob_organizationId_idx').on(table.organizationId),
		index('DomainJob_managedDomainId_idx').on(table.managedDomainId),
	],
)

/**
 * What a restaurant paid for a domain (#183): Stripe ids and amounts only.
 * `status` is `pending`, `succeeded`, `failed`, `refunded` or `refund_failed`.
 * A failed registration refunds the charge; the refund id is kept.
 */
export const DomainCharge = sqliteTable(
	'DomainCharge',
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
		managedDomainId: text().references(() => ManagedDomain.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		jobId: text().references(() => DomainJob.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		/** `registration`, `renewal` or `transfer_in`. */
		kind: text().notNull(),
		amountCents: integer().notNull(),
		currency: text().default('usd').notNull(),
		idempotencyKey: text().notNull(),
		stripePaymentIntentId: text(),
		stripeRefundId: text(),
		status: text().default('pending').notNull(),
		failureCode: text(),
		refundedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('DomainCharge_idempotencyKey_key').on(table.idempotencyKey),
		index('DomainCharge_organizationId_idx').on(table.organizationId),
		index('DomainCharge_managedDomainId_idx').on(table.managedDomainId),
	],
)

/**
 * One forwarding address on a managed domain (#276). `localPart` is `*` for the
 * catch-all. The destination is the restaurant's own inbox (an operator
 * address, not guest data); mail contents never reach us. `status` is
 * `pending_confirmation`, `active`, `failing` or `disabled`.
 */
export const DomainEmailForward = sqliteTable(
	'DomainEmailForward',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		managedDomainId: text()
			.notNull()
			.references(() => ManagedDomain.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		localPart: text().notNull(),
		destination: text().notNull(),
		status: text().default('pending_confirmation').notNull(),
		providerRuleId: text(),
		lastForwardedAt: integer({ mode: 'timestamp_ms' }),
		lastError: text(),
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
		uniqueIndex('DomainEmailForward_domain_localPart_key').on(
			table.managedDomainId,
			table.localPart,
		),
		index('DomainEmailForward_status_idx').on(table.status),
	],
)

/**
 * How an organization's guest email is sent (#103): the sender name, a reply-to
 * the operator proved with a code, and an optional custom sending domain
 * (SPF, DKIM, return path). Business identity, never guest data. The region
 * reads it through the organization metadata the App serves to tenant-api.
 * `domainStatus` is `none`, `pending`, `verified` or `failed`; `dataRegion` is
 * the region the domain was set up in (a region change needs a new check).
 */
export const OrganizationEmailSender = sqliteTable(
	'OrganizationEmailSender',
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
		senderName: text(),
		replyTo: text(),
		replyToVerifiedAt: integer({ mode: 'timestamp_ms' }),
		pendingReplyTo: text(),
		replyToCodeHash: text(),
		replyToCodeExpiresAt: integer({ mode: 'timestamp_ms' }),
		replyToCodeAttempts: integer().default(0).notNull(),
		replyToCodeSentAt: integer({ mode: 'timestamp_ms' }),
		localPart: text().default('hello').notNull(),
		domain: text(),
		domainStatus: text().default('none').notNull(),
		dkimSelector: text(),
		providerRef: text(),
		/** JSON: the SPF, DKIM and return-path records to add, each with its last result. */
		dnsRecords: text(),
		dataRegion: text(),
		checkedAt: integer({ mode: 'timestamp_ms' }),
		verifiedAt: integer({ mode: 'timestamp_ms' }),
		failedAt: integer({ mode: 'timestamp_ms' }),
		fallbackNotifiedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('OrganizationEmailSender_organizationId_key').on(
			table.organizationId,
		),
		uniqueIndex('OrganizationEmailSender_domain_key')
			.on(table.domain)
			.where(sql`${table.domain} IS NOT NULL`),
		index('OrganizationEmailSender_domainStatus_idx').on(table.domainStatus),
	],
)

/**
 * A numbered version of one Menuza agreement (#194, #89): `terms`, `privacy`,
 * `payments`, `text_marketing` or `dpa`. `title` and `summary` are
 * locale-keyed JSON. A version with `requiredBy` blocks the dashboard for
 * owners after that date; before it the dialog can be postponed. `scope` is
 * `always` (asked of every owner) or `module` (asked when that module is
 * turned on). Business data, not guest data.
 */
export const LegalAgreement = sqliteTable(
	'LegalAgreement',
	{
		key: text().notNull(),
		version: integer().notNull(),
		title: text().notNull(),
		url: text().notNull(),
		summary: text(),
		scope: text().default('always').notNull(),
		publishedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		requiredBy: integer({ mode: 'timestamp_ms' }),
	},
	(table) => [
		primaryKey({
			columns: [table.key, table.version],
			name: 'LegalAgreement_key_version_pk',
		}),
	],
)

/**
 * Who accepted which agreement version, and when (#194). Append-only: triggers
 * refuse every update and every delete except the cascade of a deleted
 * organization. `organizationId` is null for the acceptance a person gives at
 * sign-up, before any organization exists; creating an organization copies it
 * as `signup`. `userId` has no foreign key, so deleting a user never rewrites
 * a row. `ipHash` is an HMAC of the address, never the address.
 */
export const LegalAcceptance = sqliteTable(
	'LegalAcceptance',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		agreementKey: text().notNull(),
		version: integer().notNull(),
		organizationId: text().references(() => Organization.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		userId: text(),
		acceptedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		ipHash: text(),
		/** `signup`, `dialog`, `module` or `backfill`. */
		source: text().default('dialog').notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.agreementKey, table.version],
			foreignColumns: [LegalAgreement.key, LegalAgreement.version],
			name: 'LegalAcceptance_agreement_fk',
		}),
		uniqueIndex('LegalAcceptance_org_agreement_key')
			.on(table.organizationId, table.agreementKey, table.version)
			.where(sql`${table.organizationId} IS NOT NULL`),
		uniqueIndex('LegalAcceptance_user_signup_key')
			.on(table.userId, table.agreementKey, table.version)
			.where(sql`${table.organizationId} IS NULL`),
		index('LegalAcceptance_organizationId_idx').on(table.organizationId),
		index('LegalAcceptance_agreementKey_version_idx').on(
			table.agreementKey,
			table.version,
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
		// Set only after a DNS TXT proof (see verified-domain.server.ts in App),
		// together with verifiedDomainProvedAt. Readers also require
		// verifiedDomainProvedAt: migration 0025 turned the unproven legacy
		// values into pending claims.
		verifiedDomain: text(),
		verifiedDomainProvedAt: integer({ mode: 'timestamp_ms' }),
		// A claim waiting for its TXT record: the domain and the expected value.
		pendingVerifiedDomain: text(),
		verifiedDomainToken: text(),
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
		/**
		 * Unpublished header, footer and theme (#85). Null means "same as live";
		 * the public site only ever reads the live columns above.
		 */
		draftHeaderConfig: text(),
		draftFooterConfig: text(),
		draftSiteTheme: text(),
		/**
		 * Cookie banner mode (#89): `required`, `notice` or `off`. Null picks the
		 * default for the site's region (`required` in the EU, UK and KSA).
		 */
		consentMode: text(),
		/** Legal name, contact email and postal address for the legal pages (#89). */
		legalContact: text(),
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
		/** Team chat message retention in days; null keeps messages forever. */
		chatRetentionDays: integer(),
		/**
		 * IANA time zone of the organization's single staffing scope: the zone
		 * shifts, time cards and labor days are computed in. Edited in the staff
		 * settings.
		 */
		staffingTimeZone: text().default('UTC').notNull(),
		/**
		 * Cuisines served (#182): JSON array of up to three keys from
		 * `@repo/common/cuisines`. Null: not set (left out of the site).
		 */
		cuisines: text(),
		/** Price range 1 to 4 (`$` to `$$$$`); null leaves it out everywhere. */
		priceRange: integer(),
		/** Search engine site verification codes (#138), rendered escaped. */
		googleSiteVerification: text(),
		bingSiteVerification: text(),
		/** IndexNow key (#138), served by Sites at `/<key>.txt`. Generated. */
		indexNowKey: text(),
		/**
		 * Top N items to auto-mark as popular per org (#97). Null disables
		 * automatic popular marking; 3..10 enables it.
		 */
		autoPopularCount: integer(),
	},
	(table) => [
		uniqueIndex('Organization_customDomain_key').on(table.customDomain),
		uniqueIndex('Organization_slug_key').on(table.slug),
		uniqueIndex('Organization_verifiedDomain_key').on(table.verifiedDomain),
	],
)

export const OrganizationLocation = sqliteTable(
	'OrganizationLocation',
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
		slug: text().notNull(),
		phone: text(),
		timezone: text().default('America/New_York').notNull(),
		taxRate: real().default(0).notNull(),
		/**
		 * When true, menu prices already include tax (VAT): the order total is the
		 * subtotal plus tip, and the tax shown is the portion contained in it.
		 */
		taxInclusive: integer({ mode: 'boolean' }).default(false).notNull(),
		/** Seller's tax (VAT) registration number, printed on receipts. */
		vatNumber: text(),
		address: text(),
		storeHours: text(),
		onlineHours: text(),
		specialHours: text(),
		prepTime: integer().default(15).notNull(),
		largeOrderThreshold: real().default(100),
		largeOrderThresholdType: text().default('dollars').notNull(),
		largeOrderExtraPrepTime: integer().default(15).notNull(),
		fulfillmentOptions: text(),
		inHouseTips: text(),
		/**
		 * Tip buttons per order type (#118): JSON `TipSettings`
		 * (`@repo/common/location-types`). Null shows the default buttons.
		 */
		tipSettings: text(),
		/**
		 * Guest service fee (#123, `ordering.service_fee`): JSON
		 * `ServiceFeeSettings` (`@repo/common/service-fee`). Null is no fee. Policy
		 * only; the amounts charged live with each order in the regional database.
		 */
		serviceFee: text(),
		/**
		 * Online ordering buffers and per-fulfillment hours modes (#330).
		 * JSON `OnlineOrderingSettings` (`@repo/common/location-types`).
		 */
		onlineOrderingSettings: text(),
		/**
		 * Per–15-minute slot capacity (#108, #256). JSON `SlotLimitSettings`.
		 * Gated by org flag `ordering.slot_limits`.
		 */
		slotLimitSettings: text(),
		/**
		 * Prep minutes by weekday and time range (#229). JSON `PrepSchedule`.
		 */
		prepSchedule: text(),
		/**
		 * Automatic prayer-time ordering pause (#342, KSA / enabled regions only).
		 * JSON `PrayerPauseSettings`.
		 */
		prayerPauseSettings: text(),
		/**
		 * Localized pickup instructions for guests (#251). JSON map like menu copy.
		 */
		pickupInstructions: text(),
		/**
		 * Maximum regular order size per type (#422). JSON `OrderCapsSettings`.
		 */
		orderCaps: text(),
		/**
		 * Packaging / bag fee (#408). JSON `PackagingFeeSettings`.
		 */
		packagingFee: text(),
		/**
		 * Table-service courses (#290). JSON `{ enabled, autoFireMinutes, courses }`.
		 * Null is off. Course names are operator text, not guest data.
		 */
		courseSettings: text(),
		scheduling: text(),
		deliveryConfig: text(),
		deliveryZones: text(),
		/**
		 * "Pause online orders": set when an operator pauses web and QR ordering
		 * (walk-in POS sales continue). Paused while this is set and
		 * `orderingPausedUntil` is null (until someone resumes) or in the future.
		 */
		orderingPausedAt: integer({ mode: 'timestamp_ms' }),
		orderingPausedUntil: integer({ mode: 'timestamp_ms' }),
		/**
		 * Busy mode: minutes added to every prep estimate while
		 * `busyUntil` is null (until turned off) or in the future. Null is off.
		 */
		busyExtraPrepMinutes: integer(),
		busyUntil: integer({ mode: 'timestamp_ms' }),
		/**
		 * "Text guests when their order is ready" (Settings, Terminals): counter
		 * and phone orders taken on Station get one text when Kitchen marks them
		 * ready. Policy only; the number lives in the regional database.
		 */
		readyTextEnabled: integer({ mode: 'boolean' }).default(false).notNull(),
		/**
		 * Per-location Station register settings (#372, #171, #380): JSON
		 * `{ guestDetails, dishNotes, customItems, customItemMaxCents, cashVarianceFlagCents }`.
		 * Policy only; guest details live in the regional database.
		 */
		stationSettings: text(),
		/**
		 * Per-location order number format & daily reset time (#371): JSON
		 * `{ prefix, digits, resetTime }`. Policy only; null uses legacy defaults.
		 */
		orderNumberFormat: text(),
		/**
		 * "Guests can cancel within" (Settings, Locations, Online ordering;
		 * `ordering.guest_cancel`): minutes after payment (or placement) a guest
		 * may cancel their own ASAP order, one of 1, 2, 5 or 10. Null or 0 is
		 * off. `guestCancelScheduledLeadMinutes`: a scheduled order may be
		 * cancelled until this many minutes before its time (null: same window
		 * as ASAP). Policy only.
		 */
		guestCancelMinutes: integer(),
		guestCancelScheduledLeadMinutes: integer(),
		/**
		 * "Order acceptance" (`ordering.manual_acceptance`): `auto` (every order
		 * is accepted when placed) or `manual` (a person accepts or rejects it).
		 * Manual orders not decided in `orderAcceptanceTimeoutMinutes` (3, 5 or
		 * 10) are rejected automatically. `orderAcceptanceMinTotalCents` (order
		 * total, minor units; null: every order) and
		 * `orderAcceptanceScheduledOnly` narrow which orders wait.
		 */
		orderAcceptanceMode: text().default('auto').notNull(),
		orderAcceptanceTimeoutMinutes: integer().default(5).notNull(),
		orderAcceptanceMinTotalCents: integer(),
		orderAcceptanceScheduledOnly: integer({ mode: 'boolean' })
			.default(false)
			.notNull(),
		isActive: integer({ mode: 'boolean' }).default(true).notNull(),
		isDefault: integer({ mode: 'boolean' }).default(false).notNull(),
		/** Cuisines override (#182), same shape as `Organization.cuisines`. */
		cuisines: text(),
		/** Price range override (#182), 1 to 4. */
		priceRange: integer(),
		/**
		 * Location landing page (#137): `/locations/<slug>` on the website.
		 * `siteIntro` is localized JSON text; title and description override the
		 * generated ones. Turning the page off answers 410, like deactivating.
		 */
		sitePageEnabled: integer({ mode: 'boolean' }).default(true).notNull(),
		siteIntro: text(),
		siteSeoTitle: text(),
		siteSeoDescription: text(),
		/**
		 * Temporary closure (#87): the location is closed until
		 * `temporarilyClosedUntil` (null: until someone reopens it). Reopening
		 * clears both. Pushed to Google as `CLOSED_TEMPORARILY` when sync is on.
		 */
		temporarilyClosed: integer({ mode: 'boolean' }).default(false).notNull(),
		temporarilyClosedUntil: integer({ mode: 'timestamp_ms' }),
		/**
		 * The first time the launch checklist found this location live (set
		 * once, never cleared; whether it is live now is evaluated on read).
		 */
		liveAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationLocation_organizationId_idx').on(table.organizationId),
		uniqueIndex('OrganizationLocation_organizationId_slug_key').on(
			table.organizationId,
			table.slug,
		),
	],
)

/** Monthly net sales goal per location (#377), business data in the control plane. */
export const OrganizationSalesGoal = sqliteTable(
	'OrganizationSalesGoal',
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
		locationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		/** First day of month, `YYYY-MM`. */
		month: text().notNull(),
		goalMinor: integer().notNull(),
		currency: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('OrganizationSalesGoal_org_location_month_key').on(
			table.organizationId,
			table.locationId,
			table.month,
		),
		index('OrganizationSalesGoal_organizationId_month_idx').on(
			table.organizationId,
			table.month,
		),
	],
)

/**
 * Locations a member's staffing access is limited to while
 * `UserOrganization.locationScope` is 'selected'. The ids are opaque to the
 * regional tenant databases: staff records only ever carry the same ids, never
 * a foreign key. Removing a member or a location removes its grants.
 */
export const UserOrganizationLocation = sqliteTable(
	'UserOrganizationLocation',
	{
		userId: text().notNull(),
		organizationId: text().notNull(),
		locationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.userId, table.organizationId, table.locationId],
			name: 'UserOrganizationLocation_userId_organizationId_locationId_pk',
		}),
		foreignKey({
			columns: [table.userId, table.organizationId],
			foreignColumns: [
				UserOrganization.userId,
				UserOrganization.organizationId,
			],
			name: 'UserOrganizationLocation_member_fk',
		})
			.onUpdate('cascade')
			.onDelete('cascade'),
		index('UserOrganizationLocation_locationId_idx').on(table.locationId),
	],
)

/**
 * Location tags (#374): a named group of locations ("Texas", "Franchisee A").
 * Business data in the control plane, no guest data. `nameKey` is the trimmed,
 * lower-cased name so two tags cannot differ only by case.
 */
export const OrganizationLocationTag = sqliteTable(
	'OrganizationLocationTag',
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
		nameKey: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('OrganizationLocationTag_organizationId_nameKey_key').on(
			table.organizationId,
			table.nameKey,
		),
	],
)

/** Which locations carry which tag. Removing a tag or a location removes its links. */
export const OrganizationLocationTagLink = sqliteTable(
	'OrganizationLocationTagLink',
	{
		locationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		tagId: text()
			.notNull()
			.references(() => OrganizationLocationTag.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.locationId, table.tagId],
			name: 'OrganizationLocationTagLink_locationId_tagId_pk',
		}),
		index('OrganizationLocationTagLink_tagId_idx').on(table.tagId),
	],
)

/**
 * Tags a member is granted while `UserOrganization.locationScope` is
 * 'selected' (#374). The member's locations are the explicit
 * `UserOrganizationLocation` rows plus every location carrying one of these
 * tags, resolved at read time so a location added to the tag later is covered.
 */
export const UserOrganizationLocationTag = sqliteTable(
	'UserOrganizationLocationTag',
	{
		userId: text().notNull(),
		organizationId: text().notNull(),
		tagId: text()
			.notNull()
			.references(() => OrganizationLocationTag.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.userId, table.organizationId, table.tagId],
			name: 'UserOrganizationLocationTag_userId_organizationId_tagId_pk',
		}),
		foreignKey({
			columns: [table.userId, table.organizationId],
			foreignColumns: [
				UserOrganization.userId,
				UserOrganization.organizationId,
			],
			name: 'UserOrganizationLocationTag_member_fk',
		})
			.onUpdate('cascade')
			.onDelete('cascade'),
		index('UserOrganizationLocationTag_tagId_idx').on(table.tagId),
	],
)

/**
 * Chain default for one location setting (#417). `settingId` is a key of the
 * registry in `@repo/common/location-settings-registry`; `defaultValue` is the
 * registry's canonical JSON for it. While `locked` is true no location may
 * change the setting. The values are copied into each inheriting location's own
 * columns when the default changes, so Sites and the region read the same
 * columns as before. A location "overrides" the default when its own value
 * differs from it: nothing is stored for that, it is read from the columns.
 */
export const OrganizationLocationSettingPolicy = sqliteTable(
	'OrganizationLocationSettingPolicy',
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
		settingId: text().notNull(),
		defaultValue: text().notNull(),
		locked: integer({ mode: 'boolean' }).default(false).notNull(),
		/** Why head office locked it; shown to people at the location. */
		lockReason: text(),
		updatedById: text().references(() => User.id, {
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
		uniqueIndex(
			'OrganizationLocationSettingPolicy_organizationId_settingId_key',
		).on(table.organizationId, table.settingId),
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
		// One message per user per campaign: a dispatch sends only to the users
		// whose row it inserted, so two dispatches never both send.
		uniqueIndex('PlatformMarketingMessage_campaignId_userId_key').on(
			table.campaignId,
			table.userId,
		),
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

// --- Menu Management System ---

export const OrganizationMenu = sqliteTable(
	'OrganizationMenu',
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
		displayName: text().notNull(),
		internalName: text(),
		menuType: text().default('online_pos_kiosk').notNull(),
		nutritionalInfo: integer({ mode: 'boolean' }).default(true).notNull(),
		specialInstructions: integer({ mode: 'boolean' }).default(true).notNull(),
		availabilityHours: text(),
		availabilityStatus: text().default('available').notNull(),
		unavailableUntil: integer('unavailableUntil', { mode: 'timestamp_ms' }),
		/** JSON array of enabled channels (#220): ["web","qr","pos","app"]. */
		channels: text().default('["web","qr","pos","app"]').notNull(),
		position: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationMenu_organizationId_idx').on(table.organizationId),
	],
)

export const OrganizationMenuCategory = sqliteTable(
	'OrganizationMenuCategory',
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
		displayName: text().notNull(),
		internalName: text(),
		description: text(),
		upsellCategoryIds: text().default('[]').notNull(),
		availabilityHours: text(),
		availabilityStatus: text().default('available').notNull(),
		unavailableUntil: integer('unavailableUntil', { mode: 'timestamp_ms' }),
		excludeFromOverride: integer({ mode: 'boolean' }).default(false).notNull(),
		/** Dishes in this category do not count toward slot limits (#256). */
		excludeFromOrderLimits: integer({ mode: 'boolean' })
			.default(false)
			.notNull(),
		/** Course id from the location's course list (#290). Null: the first course. */
		defaultCourseId: text(),
		/** JSON array of enabled channels (#220): ["web","qr","pos","app"]. */
		channels: text().default('["web","qr","pos","app"]').notNull(),
		parentId: text().references((): any => OrganizationMenuCategory.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		position: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationMenuCategory_organizationId_idx').on(
			table.organizationId,
		),
		index('OrganizationMenuCategory_parentId_idx').on(table.parentId),
	],
)

export const OrganizationMenuCategoryAssignment = sqliteTable(
	'OrganizationMenuCategoryAssignment',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		menuId: text()
			.notNull()
			.references(() => OrganizationMenu.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		categoryId: text()
			.notNull()
			.references(() => OrganizationMenuCategory.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		position: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationMenuCategoryAssignment_menuId_idx').on(table.menuId),
		index('OrganizationMenuCategoryAssignment_categoryId_idx').on(
			table.categoryId,
		),
		uniqueIndex('OrganizationMenuCategoryAssignment_menu_category_key').on(
			table.menuId,
			table.categoryId,
		),
	],
)

export const OrganizationMenuItem = sqliteTable(
	'OrganizationMenuItem',
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
		displayName: text().notNull(),
		internalName: text(),
		description: text(),
		price: real().default(0).notNull(),
		imageKey: text(),
		imageUrl: text(),
		imageKeys: text().default('[]').notNull(),
		variations: text().default('{"groups":[],"variants":[]}').notNull(),
		isAlcohol: integer({ mode: 'boolean' }).default(false).notNull(),
		isGlutenFree: integer({ mode: 'boolean' }).default(false).notNull(),
		isVegetarian: integer({ mode: 'boolean' }).default(false).notNull(),
		/**
		 * Dietary tags (#335), JSON `DietaryTag[]`. Source of truth for the
		 * dietary claims; `isVegetarian` and `isGlutenFree` are kept equal to
		 * it on every write so older readers keep working.
		 */
		dietaryTags: text().default('[]').notNull(),
		/** Prices per order type (#412), JSON `OrderTypePrices`. Null: base price. */
		orderTypePrices: text(),
		allergens: text().default('[]').notNull(),
		calorieMin: integer(),
		calorieMax: integer(),
		applySalesTax: integer({ mode: 'boolean' }).default(true).notNull(),
		excludeFromOverride: integer({ mode: 'boolean' }).default(false).notNull(),
		// Never receives any discount (gift cards, consignment goods).
		excludeFromDiscounts: integer({ mode: 'boolean' }).default(false).notNull(),
		/** Does not count toward per-slot order/dish limits (#256). */
		excludeFromOrderLimits: integer({ mode: 'boolean' })
			.default(false)
			.notNull(),
		/** Daily quantity cap per location (#409). JSON `DailySaleLimit`. */
		dailySaleLimit: text(),
		/** Localized kitchen ticket name (#413). Same JSON shape as displayName. */
		kitchenName: text(),
		/** none | allergy | attention | long_prep. Null uses the removal default. */
		kitchenHighlight: text(),
		isPopular: integer({ mode: 'boolean' }).default(false).notNull(),
		/** Popularity mode (#97): 'auto' | 'always' | 'never'. */
		popularMode: text().default('auto').notNull(),
		isUpsell: integer({ mode: 'boolean' }).default(false).notNull(),
		/**
		 * "Give this dish its own page" (#137, `website.dish_pages`): published
		 * at `/menu/<siteSlug>` while the dish is visible online.
		 */
		sitePageEnabled: integer({ mode: 'boolean' }).default(false).notNull(),
		siteSlug: text(),
		availabilityStatus: text().default('available').notNull(),
		unavailableUntil: integer('unavailableUntil', { mode: 'timestamp_ms' }),
		/** JSON array of enabled channels (#220): ["web","qr","pos","app"]. */
		channels: text().default('["web","qr","pos","app"]').notNull(),
		position: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationMenuItem_organizationId_idx').on(table.organizationId),
	],
)

export const OrganizationMenuItemCategoryAssignment = sqliteTable(
	'OrganizationMenuItemCategoryAssignment',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		categoryId: text()
			.notNull()
			.references(() => OrganizationMenuCategory.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		itemId: text()
			.notNull()
			.references(() => OrganizationMenuItem.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		position: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationMenuItemCategoryAssignment_categoryId_idx').on(
			table.categoryId,
		),
		index('OrganizationMenuItemCategoryAssignment_itemId_idx').on(table.itemId),
		uniqueIndex('OrganizationMenuItemCategoryAssignment_cat_item_key').on(
			table.categoryId,
			table.itemId,
		),
	],
)

export const OrganizationMenuModifierGroup = sqliteTable(
	'OrganizationMenuModifierGroup',
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
		internalName: text(),
		selectionType: text().default('single').notNull(),
		minSelections: integer().default(0).notNull(),
		maxSelections: integer(),
		availabilityStatus: text().default('available').notNull(),
		unavailableUntil: integer('unavailableUntil', { mode: 'timestamp_ms' }),
		position: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationMenuModifierGroup_organizationId_idx').on(
			table.organizationId,
		),
	],
)

export const OrganizationMenuItemModifierGroupAssignment = sqliteTable(
	'OrganizationMenuItemModifierGroupAssignment',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		itemId: text()
			.notNull()
			.references(() => OrganizationMenuItem.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		modifierGroupId: text()
			.notNull()
			.references(() => OrganizationMenuModifierGroup.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		position: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationMenuItemModifierGroupAssignment_itemId_idx').on(
			table.itemId,
		),
		index('OrganizationMenuItemModifierGroupAssignment_modifierGroupId_idx').on(
			table.modifierGroupId,
		),
		uniqueIndex(
			'OrganizationMenuItemModifierGroupAssignment_item_group_key',
		).on(table.itemId, table.modifierGroupId),
	],
)

export const OrganizationMenuOption = sqliteTable(
	'OrganizationMenuOption',
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
		displayName: text().notNull(),
		internalName: text(),
		description: text(),
		imageKey: text(),
		price: real().default(0).notNull(),
		priceWhole: real(),
		priceLeft: real(),
		priceRight: real(),
		calories: integer(),
		minSelections: integer().default(0).notNull(),
		maxSelections: integer(),
		isAlcohol: integer({ mode: 'boolean' }).default(false).notNull(),
		isGlutenFree: integer({ mode: 'boolean' }).default(false).notNull(),
		isVegetarian: integer({ mode: 'boolean' }).default(false).notNull(),
		isTopping: integer({ mode: 'boolean' }).default(false).notNull(),
		/** Dietary tags (#335); see OrganizationMenuItem.dietaryTags. */
		dietaryTags: text().default('[]').notNull(),
		/** Prices per order type (#412), JSON `OrderTypePrices`. Null: base price. */
		orderTypePrices: text(),
		allergens: text().default('[]').notNull(),
		applySalesTax: integer({ mode: 'boolean' }).default(true).notNull(),
		availabilityStatus: text().default('available').notNull(),
		unavailableUntil: integer('unavailableUntil', { mode: 'timestamp_ms' }),
		/** Daily quantity cap per location (#409). JSON `DailySaleLimit`. */
		dailySaleLimit: text(),
		/** Localized kitchen ticket name (#413). Same JSON shape as displayName. */
		kitchenName: text(),
		/** none | allergy | attention | long_prep. Null uses the removal default. */
		kitchenHighlight: text(),
		nestedModifierGroupIds: text().default('[]').notNull(),
		position: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationMenuOption_organizationId_idx').on(table.organizationId),
	],
)

export const OrganizationMenuModifierGroupOptionAssignment = sqliteTable(
	'OrganizationMenuModifierGroupOptionAssignment',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		modifierGroupId: text()
			.notNull()
			.references(() => OrganizationMenuModifierGroup.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		optionId: text()
			.notNull()
			.references(() => OrganizationMenuOption.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		priceOverride: real(),
		priceWholeOverride: real(),
		priceLeftOverride: real(),
		priceRightOverride: real(),
		isDefault: integer({ mode: 'boolean' }).default(false).notNull(),
		position: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index(
			'OrganizationMenuModifierGroupOptionAssignment_modifierGroupId_idx',
		).on(table.modifierGroupId),
		index('OrganizationMenuModifierGroupOptionAssignment_optionId_idx').on(
			table.optionId,
		),
		uniqueIndex(
			'OrganizationMenuModifierGroupOptionAssignment_group_option_key',
		).on(table.modifierGroupId, table.optionId),
	],
)

export const OrganizationMenuOptionNestedModifierGroupAssignment = sqliteTable(
	'OrganizationMenuOptionNestedModifierGroupAssignment',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		optionId: text()
			.notNull()
			.references(() => OrganizationMenuOption.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		modifierGroupId: text()
			.notNull()
			.references(() => OrganizationMenuModifierGroup.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		position: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrgMenuOptNestedModGrpAsgn_optId_idx').on(table.optionId),
		index('OrgMenuOptNestedModGrpAsgn_groupId_idx').on(table.modifierGroupId),
		uniqueIndex('OrgMenuOptNestedModGrpAsgn_opt_group_key').on(
			table.optionId,
			table.modifierGroupId,
		),
	],
)

export const OrganizationMenuLocationOverride = sqliteTable(
	'OrganizationMenuLocationOverride',
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
		locationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		entityType: text().notNull(), // 'menu' | 'category' | 'item' | 'modifier_group' | 'modifier_option'
		entityId: text().notNull(),
		isEnabled: integer({ mode: 'boolean' }),
		price: real(),
		availabilityStatus: text(),
		unavailableUntil: integer('unavailableUntil', { mode: 'timestamp_ms' }),
		/** Nullable JSON array of channels (#220); may only narrow the base channels. */
		channels: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationMenuLocationOverride_locationId_idx').on(
			table.locationId,
		),
		uniqueIndex('OrganizationMenuLocationOverride_loc_entity_key').on(
			table.locationId,
			table.entityType,
			table.entityId,
		),
	],
)

/**
 * Percentage pricing rule (#388): +N% (or -N%) on the dishes of chosen menus
 * or categories at chosen locations, rounded up, optionally skipping a price
 * range. Covers dishes added later. A fixed per-location price override wins.
 * Business data only. `endedAt` set: the rule no longer applies.
 */
export const OrganizationMenuPricingRule = sqliteTable(
	'OrganizationMenuPricingRule',
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
		/** Basis points: 1000 is +10%, -500 is -5%. */
		percentBp: integer().notNull(),
		/** JSON string[]; empty with empty categoryIds means every dish. */
		menuIds: text().default('[]').notNull(),
		categoryIds: text().default('[]').notNull(),
		/** JSON string[]; empty means every location. */
		locationIds: text().default('[]').notNull(),
		/** none | decimals | amount */
		roundingMode: text().default('none').notNull(),
		/** decimals: 0 or 1; amount: minor units (25 is 0.25). */
		roundingValue: integer().default(0).notNull(),
		/** Prices from this (major units, inclusive) are left alone. */
		excludeMinPrice: real(),
		excludeMaxPrice: real(),
		startsAt: integer({ mode: 'timestamp_ms' }),
		endedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationMenuPricingRule_organizationId_idx').on(
			table.organizationId,
		),
	],
)

// Maps a menu entity to its counterpart on a connected POS/delivery platform,
// so imports and pushes are idempotent across syncs.
export const OrganizationMenuPosLink = sqliteTable(
	'OrganizationMenuPosLink',
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
		integrationId: text()
			.notNull()
			.references(() => Integration.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		providerName: text().notNull(),
		entityType: text().notNull(), // 'category' | 'item' | 'modifier_group'
		remoteId: text().notNull(),
		localId: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationMenuPosLink_organizationId_idx').on(
			table.organizationId,
		),
		index('OrganizationMenuPosLink_integrationId_idx').on(table.integrationId),
		uniqueIndex('OrganizationMenuPosLink_integration_entity_remote_key').on(
			table.integrationId,
			table.entityType,
			table.remoteId,
		),
	],
)

export const MENU_SNAPSHOT_REASONS = [
	'manual',
	'before_bulk_edit',
	'before_restore',
	'before_import',
	'before_schedule',
	// Taken before a review-stack card is accepted; Undo restores from it.
	'before_suggestion',
] as const
export type MenuSnapshotReason = (typeof MENU_SNAPSHOT_REASONS)[number]

/** Immutable whole-menu JSON in R2; row holds metadata and the object key. */
export const MenuSnapshot = sqliteTable(
	'MenuSnapshot',
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
		reason: text().notNull(),
		label: text(),
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		itemCount: integer().default(0).notNull(),
		contentKey: text().notNull(),
		contentHash: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('MenuSnapshot_organizationId_idx').on(table.organizationId),
		index('MenuSnapshot_organizationId_createdAt_idx').on(
			table.organizationId,
			table.createdAt,
		),
	],
)

export const MENU_CHECK_DISMISSAL_ENTITY_TYPES = [
	'item',
	'category',
	'modifier_group',
	'option',
	'menu',
] as const
export type MenuCheckDismissalEntityType =
	(typeof MENU_CHECK_DISMISSAL_ENTITY_TYPES)[number]

/**
 * A Menu health check dismissed for one record, or a review card skipped as
 * "not a problem". It applies only while the record still matches
 * `fingerprint`, the state it was dismissed against. `entityId` has no foreign
 * key: it points at one of several tables, named by `entityType`.
 */
export const MenuCheckDismissal = sqliteTable(
	'MenuCheckDismissal',
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
		entityType: text().notNull(),
		entityId: text().notNull(),
		/** A Menu health check key (`no_photo`) or `card:<kind>`. */
		checkKey: text().notNull(),
		/** Short code, e.g. `on_purpose` or `not_a_problem`. */
		reason: text(),
		fingerprint: text().default('').notNull(),
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('MenuCheckDismissal_org_entity_check_key').on(
			table.organizationId,
			table.entityId,
			table.checkKey,
		),
		index('MenuCheckDismissal_organizationId_idx').on(table.organizationId),
	],
)

export const MENU_SCHEDULE_STATUSES = ['pending', 'done', 'cancelled'] as const
export type MenuScheduleStatus = (typeof MENU_SCHEDULE_STATUSES)[number]

/**
 * Scheduled menu changeover (#149): at `goLiveAt`, sets `menuId` to
 * `'available'` and (optionally) `takeOffMenuId` to `'unavailable'`. At most
 * one `'pending'` schedule per menu.
 */
export const MenuSchedule = sqliteTable(
	'MenuSchedule',
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
		menuId: text()
			.notNull()
			.references(() => OrganizationMenu.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		goLiveAt: integer({ mode: 'timestamp_ms' }).notNull(),
		takeOffMenuId: text().references(() => OrganizationMenu.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		/** `pending` | `done` | `cancelled`. */
		status: text().default('pending').notNull(),
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
		uniqueIndex('MenuSchedule_pending_menu_key')
			.on(table.menuId)
			.where(sql`${table.status} = 'pending'`),
		index('MenuSchedule_organizationId_idx').on(table.organizationId),
		index('MenuSchedule_status_goLiveAt_idx').on(table.status, table.goLiveAt),
		index('MenuSchedule_takeOffMenuId_idx').on(table.takeOffMenuId),
	],
)

export const MENU_IMPORT_SOURCE_KINDS = [
	'url',
	'pdf',
	'image',
	'spreadsheet',
] as const
export type MenuImportSourceKind = (typeof MENU_IMPORT_SOURCE_KINDS)[number]

export const MENU_IMPORT_STATUSES = [
	'queued',
	'running',
	'ready',
	'applying',
	'applied',
	'failed',
	'cancelled',
] as const
export type MenuImportStatus = (typeof MENU_IMPORT_STATUSES)[number]

/**
 * AI menu import job (#73): extracts a structured draft from a URL, PDF,
 * image, or spreadsheet into R2 (`draftKey`) before operator review & apply.
 * At most one active (`queued`, `running`, `applying`) import per org.
 */
export const MenuImport = sqliteTable(
	'MenuImport',
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
		/** `url` | `pdf` | `image` | `spreadsheet`. */
		sourceKind: text().notNull(),
		sourceUrl: text(),
		sourceKey: text(),
		/** `queued` | `running` | `ready` | `applying` | `applied` | `failed` | `cancelled`. */
		status: text().default('queued').notNull(),
		error: text(),
		draftKey: text(),
		appliedAt: integer({ mode: 'timestamp_ms' }),
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		confirmedOwnership: integer({ mode: 'boolean' }).default(false).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('MenuImport_active_org_key')
			.on(table.organizationId)
			.where(sql`${table.status} IN ('queued', 'running', 'applying')`),
		index('MenuImport_organizationId_idx').on(table.organizationId),
		index('MenuImport_organizationId_createdAt_idx').on(
			table.organizationId,
			table.createdAt,
		),
	],
)

/**
 * A member's "Dismiss for a week" on one home Needs attention item. Items
 * are computed on read; only dismissals are stored. `key` is the item's kind
 * and location (`menu_health:org`, `ordering_paused:<locationId>`); a
 * dismissal holds until `dismissedUntil` even if the problem clears and
 * comes back. Per user: nobody sees or inherits another member's dismissals.
 */
export const HomeAttentionDismissal = sqliteTable(
	'HomeAttentionDismissal',
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
		key: text().notNull(),
		dismissedUntil: integer({ mode: 'timestamp_ms' }).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('HomeAttentionDismissal_user_org_key_key').on(
			table.userId,
			table.organizationId,
			table.key,
		),
		index('HomeAttentionDismissal_organizationId_idx').on(table.organizationId),
	],
)

// --- Menu Drops System ---

export const OrganizationDrop = sqliteTable(
	'OrganizationDrop',
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
		menuId: text()
			.notNull()
			.references(() => OrganizationMenu.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		title: text().notNull(),
		slug: text().notNull(),
		description: text(),
		coverImageKey: text(),
		coverImageUrl: text(),
		status: text().default('draft').notNull(),
		ordersOpenAt: integer('ordersOpenAt', { mode: 'timestamp_ms' }),
		ordersCloseAt: integer('ordersCloseAt', { mode: 'timestamp_ms' }),
		visibility: text().default('public').notNull(),
		checkoutHoldMinutes: integer().default(5).notNull(),
		showOrdersOpenTime: integer({ mode: 'boolean' }).default(true).notNull(),
		showMenuPreview: integer({ mode: 'boolean' }).default(true).notNull(),
		showInventoryRemaining: integer({ mode: 'boolean' })
			.default(true)
			.notNull(),
		includeGiftCard: integer({ mode: 'boolean' }).default(false).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationDrop_organizationId_idx').on(table.organizationId),
		index('OrganizationDrop_menuId_idx').on(table.menuId),
		uniqueIndex('OrganizationDrop_organizationId_slug_key').on(
			table.organizationId,
			table.slug,
		),
	],
)

export const OrganizationDropPickupWindow = sqliteTable(
	'OrganizationDropPickupWindow',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		dropId: text()
			.notNull()
			.references(() => OrganizationDrop.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		locationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		date: text().notNull(),
		startTime: text().notNull(),
		endTime: text().notNull(),
		slotIntervalMinutes: integer().default(30).notNull(),
		maxOrdersPerSlot: integer(),
		orderLeadTimeMinutes: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationDropPickupWindow_dropId_idx').on(table.dropId),
		index('OrganizationDropPickupWindow_locationId_idx').on(table.locationId),
	],
)

export const OrganizationDropInventory = sqliteTable(
	'OrganizationDropInventory',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		dropId: text()
			.notNull()
			.references(() => OrganizationDrop.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		entityType: text().notNull(), // 'item' | 'category'
		entityId: text().notNull(),
		inventory: integer(),
		maxPerOrder: integer(),
		maxPerPickupSlot: integer(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('OrganizationDropInventory_dropId_idx').on(table.dropId),
		uniqueIndex('OrganizationDropInventory_drop_entity_key').on(
			table.dropId,
			table.entityType,
			table.entityId,
		),
	],
)

export const OrganizationDropReminder = sqliteTable(
	'OrganizationDropReminder',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		dropId: text()
			.notNull()
			.references(() => OrganizationDrop.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		title: text().notNull(),
		message: text(),
		triggerType: text().notNull(), // 'before_open' | 'before_close' | 'custom'
		scheduledAt: integer('scheduledAt', { mode: 'timestamp_ms' }).notNull(),
		status: text().default('pending').notNull(),
		sentAt: integer('sentAt', { mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [index('OrganizationDropReminder_dropId_idx').on(table.dropId)],
)

// Per-user org dashboards. `config` holds only block types, report/template
// ids and grid positions, never customer data. A user's `home` dashboard is
// created lazily on their first change, and each user has at most one per org.
export const Dashboard = sqliteTable(
	'Dashboard',
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
		ownerId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		kind: text({ enum: ['home', 'custom'] }).notNull(),
		name: text().notNull(),
		config: text().notNull(), // JSON DashboardConfig
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('Dashboard_organizationId_ownerId_idx').on(
			table.organizationId,
			table.ownerId,
		),
		uniqueIndex('Dashboard_organizationId_ownerId_home_key')
			.on(table.organizationId, table.ownerId)
			.where(sql`${table.kind} = 'home'`),
	],
)

// Custom dashboards shared with other org members. Only the owner shares, and
// a recipient also needs an active membership in the dashboard's org.
export const DashboardShare = sqliteTable(
	'DashboardShare',
	{
		dashboardId: text()
			.notNull()
			.references(() => Dashboard.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		access: text({ enum: ['view', 'edit'] }).notNull(),
		sharedById: text()
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
		primaryKey({
			columns: [table.dashboardId, table.userId],
			name: 'DashboardShare_dashboardId_userId_pk',
		}),
		index('DashboardShare_userId_idx').on(table.userId),
	],
)

// AI phone agent configuration. Holds no caller data: calls, transcripts, and
// caller numbers live in the regional tenant database.
export const PhoneAgent = sqliteTable(
	'PhoneAgent',
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
		settings: text().notNull(), // JSON PhoneAgentSettings
		publishedFlowVersionId: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('PhoneAgent_organizationId_key').on(table.organizationId),
	],
)

// Platform-owned phone numbers (bought from the carrier by the platform, not
// by organizations). Assigned when `assignedOrganizationId` is set; retired
// numbers stay for history and can't be assigned again.
//
// The `released*` columns quarantine a recycled number: the previous
// organization may still forward its public line to it at the carrier, so
// handing it to another organization too soon sends their callers to the
// wrong agent. `releasedFromOrganizationId` deliberately has no foreign key so
// the quarantine survives the previous organization being deleted.
export const PlatformPhoneNumber = sqliteTable(
	'PlatformPhoneNumber',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		e164: text().notNull(),
		label: text(),
		provider: text().default('twilio').notNull(), // 'twilio'
		assignedOrganizationId: text().references(() => Organization.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		assignedAt: integer({ mode: 'timestamp_ms' }),
		retiredAt: integer({ mode: 'timestamp_ms' }),
		releasedAt: integer({ mode: 'timestamp_ms' }),
		releasedFromOrganizationId: text(),
		releasedWithVerifiedForwarding: integer({ mode: 'boolean' })
			.default(false)
			.notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('PlatformPhoneNumber_e164_key').on(table.e164),
		index('PlatformPhoneNumber_assignedOrganizationId_idx').on(
			table.assignedOrganizationId,
		),
	],
)

export const PhoneAgentNumber = sqliteTable(
	'PhoneAgentNumber',
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
		// Opaque part of the business the number answers for (a vertical
		// defines what it means). No foreign key: the core doesn't know the table.
		scopeId: text(),
		// The platform number this row answers on; `e164` mirrors its number.
		platformNumberId: text().references(() => PlatformPhoneNumber.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		e164: text().notNull(),
		mode: text().default('forwarding').notNull(), // 'forwarding' | 'dedicated'
		forwardedFrom: text(),
		// Forwarded rows stay inactive until the organization proves it owns
		// `forwardedFrom`, so unverified lines never reach the agent.
		isActive: integer({ mode: 'boolean' }).default(true).notNull(),
		verifiedAt: integer({ mode: 'timestamp_ms' }),
		verificationCodeHash: text(),
		verificationExpiresAt: integer({ mode: 'timestamp_ms' }),
		verificationAttempts: integer().default(0).notNull(),
		verificationSentAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('PhoneAgentNumber_organizationId_idx').on(table.organizationId),
		uniqueIndex('PhoneAgentNumber_e164_key').on(table.e164),
		uniqueIndex('PhoneAgentNumber_platformNumberId_key').on(
			table.platformNumberId,
		),
	],
)

export const PhoneAgentFlowVersion = sqliteTable(
	'PhoneAgentFlowVersion',
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
		version: integer().notNull(),
		graph: text().notNull(), // JSON FlowGraph
		status: text().default('draft').notNull(), // 'draft' | 'published' | 'archived'
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
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
		uniqueIndex('PhoneAgentFlowVersion_organizationId_version_key').on(
			table.organizationId,
			table.version,
		),
	],
)

export const PhoneAgentTrainingRule = sqliteTable(
	'PhoneAgentTrainingRule',
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
		// Limits the rule to one scope; null applies everywhere. No foreign key.
		scopeId: text(),
		category: text().notNull(),
		title: text().notNull(),
		description: text().notNull(),
		priority: text().default('medium').notNull(), // 'high' | 'medium' | 'low'
		isActive: integer({ mode: 'boolean' }).default(true).notNull(),
		sortOrder: integer().default(0).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('PhoneAgentTrainingRule_organizationId_idx').on(table.organizationId),
	],
)

/**
 * Control-plane outbox for staffing events that must reach the regional
 * tenant database (link a login to a staff row, unlink, erase). Rows carry ids
 * only: never names, contact details, pay, or times. A job drains the table and
 * retries with backoff until the regional node acknowledges.
 */
export const StaffingOutbox = sqliteTable(
	'StaffingOutbox',
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
		kind: text().notNull(), // 'link_user' | 'unlink_user' | 'erase_user'
		payload: text({ mode: 'json' }).notNull(), // ids only
		status: text().default('pending').notNull(), // 'pending' | 'done' | 'failed'
		attempts: integer().default(0).notNull(),
		nextAttemptAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		lastError: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('StaffingOutbox_status_nextAttemptAt_idx').on(
			table.status,
			table.nextAttemptAt,
		),
		index('StaffingOutbox_organizationId_idx').on(table.organizationId),
	],
)

/**
 * One row per manager emailed about a staffing alert event, written before the
 * email is sent. A redelivered or concurrent event finds the row and sends
 * nothing. Ids only.
 */
export const StaffingAlertEmail = sqliteTable(
	'StaffingAlertEmail',
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
		eventId: text().notNull(),
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('StaffingAlertEmail_organizationId_eventId_userId_key').on(
			table.organizationId,
			table.eventId,
			table.userId,
		),
		index('StaffingAlertEmail_userId_idx').on(table.userId),
	],
)

/**
 * A public job posting (staffing.hiring). Public content only: a role, its
 * description and pay range, and the questions an applicant answers. No person
 * data is ever stored here. Applicants live in the regional tenant database and
 * refer to a posting by this id (ADR 047, decision 8). The careers pages on
 * Sites render published rows server side, and the sanitized description is
 * sanitized again when it is rendered.
 */
export const JobPosting = sqliteTable(
	'JobPosting',
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
		// Legacy single location, mirrored from `locationIds` when exactly one is
		// chosen. Reads use `locationIds`.
		locationId: text().references(() => OrganizationLocation.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		// Where the job is: location ids, or empty for every location (including
		// ones added later). The applicant picks when there is more than one.
		locationIds: text({ mode: 'json' }).default([]).notNull(),
		slug: text().notNull(),
		title: text().notNull(),
		positionName: text().notNull(),
		employmentType: text().default('part_time').notNull(),
		payType: text().default('none').notNull(), // none | hourly | weekly | monthly | yearly
		payMinMinor: integer(),
		payMaxMinor: integer(),
		currency: text().default('USD').notNull(),
		descriptionHtml: text().default('').notNull(), // sanitized HTML
		questions: text({ mode: 'json' }).default([]).notNull(), // screener questions
		// Other-language copy: { [locale]: { title, descriptionHtml, prompts } }.
		translations: text({ mode: 'json' }).default({}).notNull(),
		// The evergreen "General application": offered by default, never expires.
		isGeneral: integer({ mode: 'boolean' }).default(false).notNull(),
		status: text().default('draft').notNull(), // draft | published | closed | expired
		publishedAt: integer({ mode: 'timestamp_ms' }),
		closedAt: integer({ mode: 'timestamp_ms' }),
		expiresAt: integer({ mode: 'timestamp_ms' }),
		createdByUserId: text().references(() => User.id, {
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
		uniqueIndex('JobPosting_organizationId_slug_key').on(
			table.organizationId,
			table.slug,
		),
		index('JobPosting_organizationId_status_idx').on(
			table.organizationId,
			table.status,
		),
		index('JobPosting_status_expiresAt_idx').on(table.status, table.expiresAt),
		index('JobPosting_locationId_idx').on(table.locationId),
	],
)

// --- Print shop (operator B2B prints: designs, renders, shipped orders) ---
// Operator business data only: no customer PII. Artwork may embed a print
// vertical's QR codes (capabilities that are printed in public anyway).

export const PrintDesign = sqliteTable(
	'PrintDesign',
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
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		name: text().notNull(),
		product: text().notNull(), // PrintProductKey
		sizeKey: text().notNull(),
		style: text().notNull(), // classic | bold | minimal
		templateVersion: integer().notNull(),
		content: text({ mode: 'json' }).notNull(), // PrintDesignContent
		// `template` (designed here) or `artwork` (a finished file, e.g. Canva).
		source: text().default('template').notNull(),
		artwork: text({ mode: 'json' }), // PrintArtwork, for `artwork` designs
		status: text().default('draft').notNull(), // draft | approved
		// The frozen PrintSnapshot the operator approved; orders print this.
		snapshot: text({ mode: 'json' }),
		snapshotHash: text(),
		approvedAt: integer({ mode: 'timestamp_ms' }),
		approvedById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		archivedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('PrintDesign_organizationId_updatedAt_idx').on(
			table.organizationId,
			table.updatedAt,
		),
	],
)

// Rendered PDFs in object storage, keyed by a hash of everything that shapes
// the file, so the same input is never rendered twice. Rows also count
// renders per organization for the hourly render limit.
export const PrintRender = sqliteTable(
	'PrintRender',
	{
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		// Hash of the render input; the same input of two orgs is two files.
		hash: text().notNull(),
		objectKey: text().notNull(),
		// 0 while the render is in progress (the row reserves the slot).
		byteLength: integer().default(0).notNull(),
		// Free downloads count against the hourly limit; paid orders do not.
		countsTowardLimit: integer({ mode: 'boolean' }).default(true).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.organizationId, table.hash] }),
		index('PrintRender_organizationId_createdAt_idx').on(
			table.organizationId,
			table.createdAt,
		),
	],
)

// Admin-managed catalog: each shippable product and size maps to one vendor
// SKU. Switching the vendor is an Admin change, never automatic failover.
export const PrintVendorProduct = sqliteTable(
	'PrintVendorProduct',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		product: text().notNull(),
		sizeKey: text().notNull(),
		vendor: text().notNull(), // gelato | prodigi
		vendorSku: text().notNull(),
		bleedMm: integer().default(3).notNull(),
		active: integer({ mode: 'boolean' }).default(true).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('PrintVendorProduct_product_size_active_key')
			.on(table.product, table.sizeKey)
			.where(sql`${table.active} = 1`),
	],
)

// One row (`id = 'default'`): markup and quote rules for shipped prints.
export const PrintSettings = sqliteTable('PrintSettings', {
	id: text().primaryKey().notNull(),
	markupBp: integer().default(3000).notNull(),
	driftHoldBp: integer().default(1000).notNull(),
	quoteTtlMinutes: integer().default(30).notNull(),
	updatedAt: integer({ mode: 'timestamp_ms' })
		.$defaultFn(() => new Date())
		.$onUpdate(() => new Date())
		.notNull(),
})

export const PrintOrder = sqliteTable(
	'PrintOrder',
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
		placedById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		// quote | awaiting_payment | paid | submitting | submitted | in_production
		// | shipped | delivered | held | failed | cancelled | refunded
		status: text().default('quote').notNull(),
		currency: text().default('USD').notNull(),
		itemsCents: integer().notNull(),
		shippingCents: integer().notNull(),
		taxCents: integer().default(0).notNull(),
		totalCents: integer().notNull(),
		wholesaleCents: integer().notNull(),
		markupBp: integer().notNull(),
		quoteExpiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
		// The vertical's scope whose address prefilled the ship-to (opaque).
		scopeId: text(),
		recipientName: text().notNull(),
		recipientPhone: text().notNull(),
		addressLine1: text().notNull(),
		addressLine2: text(),
		city: text().notNull(),
		state: text().notNull(),
		postalCode: text().notNull(),
		country: text().default('US').notNull(),
		stripeCheckoutSessionId: text(),
		stripePaymentIntentId: text(),
		holdReason: text(),
		failureReason: text(),
		refundCents: integer().default(0).notNull(),
		paidAt: integer({ mode: 'timestamp_ms' }),
		cancelledAt: integer({ mode: 'timestamp_ms' }),
		refundedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('PrintOrder_organizationId_createdAt_idx').on(
			table.organizationId,
			table.createdAt,
		),
		index('PrintOrder_status_updatedAt_idx').on(table.status, table.updatedAt),
		uniqueIndex('PrintOrder_stripeCheckoutSessionId_key').on(
			table.stripeCheckoutSessionId,
		),
	],
)

export const PrintVendorOrder = sqliteTable(
	'PrintVendorOrder',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		orderId: text()
			.notNull()
			.references(() => PrintOrder.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		vendor: text().notNull(),
		vendorOrderId: text(),
		// pending | submitted | in_production | shipped | delivered | cancelled
		// | failed
		status: text().default('pending').notNull(),
		shippingMethod: text(),
		wholesaleItemsCents: integer().notNull(),
		wholesaleShippingCents: integer().notNull(),
		carrier: text(),
		trackingNumber: text(),
		trackingUrl: text(),
		error: text(),
		submittedAt: integer({ mode: 'timestamp_ms' }),
		shippedAt: integer({ mode: 'timestamp_ms' }),
		deliveredAt: integer({ mode: 'timestamp_ms' }),
		lastEventAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('PrintVendorOrder_orderId_idx').on(table.orderId),
		uniqueIndex('PrintVendorOrder_vendor_vendorOrderId_key').on(
			table.vendor,
			table.vendorOrderId,
		),
	],
)

export const PrintOrderItem = sqliteTable(
	'PrintOrderItem',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		orderId: text()
			.notNull()
			.references(() => PrintOrder.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		vendorOrderId: text().references(() => PrintVendorOrder.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		designId: text()
			.notNull()
			.references(() => PrintDesign.id, {
				onDelete: 'restrict',
				onUpdate: 'cascade',
			}),
		snapshotHash: text().notNull(),
		// The approved snapshot as quoted: files are printed from this copy,
		// never from the design row, which the operator may edit later.
		snapshot: text({ mode: 'json' }).notNull(),
		product: text().notNull(),
		sizeKey: text().notNull(),
		vendor: text().notNull(),
		vendorSku: text().notNull(),
		// Copies of each piece (a set of cards has one piece per card).
		quantity: integer().notNull(),
		pieces: integer().notNull(),
		wholesaleCents: integer().notNull(),
		retailCents: integer().notNull(),
		pdfObjectKey: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [index('PrintOrderItem_orderId_idx').on(table.orderId)],
)

// Vendor webhook deliveries already processed (idempotency).
export const PrintVendorEvent = sqliteTable('PrintVendorEvent', {
	id: text().primaryKey().notNull(), // `${vendor}:${eventId}`
	vendor: text().notNull(),
	receivedAt: integer({ mode: 'timestamp_ms' })
		.$defaultFn(() => new Date())
		.notNull(),
})

/**
 * A member's Canva account, for importing designs into the Print shop and
 * sending prints to Canva. Per organization and user: designs belong to the
 * person's Canva account. Tokens are encrypted (INTEGRATION_ENCRYPTION_KEY);
 * Canva refresh tokens are single use, so a refresh replaces both.
 */
export const PrintCanvaConnection = sqliteTable(
	'PrintCanvaConnection',
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
		userId: text()
			.notNull()
			.references(() => User.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
		canvaUserId: text(),
		displayName: text(),
		accessToken: text().notNull(),
		refreshToken: text().notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
		scope: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('PrintCanvaConnection_organizationId_userId_key').on(
			table.organizationId,
			table.userId,
		),
	],
)

/**
 * A social media account the organization publishes to: a Facebook Page or an
 * Instagram professional account (both through Meta). Shared by the
 * organization's members. The Page access token is encrypted
 * (INTEGRATION_ENCRYPTION_KEY) and never reaches the browser.
 */
export const SocialAccount = sqliteTable(
	'SocialAccount',
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
		platform: text().notNull(), // facebook | instagram
		// The Page id (Facebook), Instagram user id, or Google location name
		// (`locations/123`, platform `google_business`, #135).
		externalId: text().notNull(),
		name: text().notNull(),
		username: text(),
		/**
		 * Google accounts (#135) read the token from the linked
		 * `Integration`; this column holds only an encrypted marker.
		 */
		accessToken: text().notNull(),
		/** The Menuza location a `google_business` account posts for. */
		organizationLocationId: text().references(() => OrganizationLocation.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		// active | needs_reauth (Meta refused the token; connect again)
		status: text().default('active').notNull(),
		connectedById: text().references(() => User.id, {
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
		uniqueIndex('SocialAccount_organizationId_platform_externalId_key').on(
			table.organizationId,
			table.platform,
			table.externalId,
		),
	],
)

export const SocialPost = sqliteTable(
	'SocialPost',
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
		createdById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		body: text().default('').notNull(),
		media: text({ mode: 'json' }).notNull(), // SocialPostMedia[]
		// draft | scheduled | publishing | published | partial | failed
		status: text().default('draft').notNull(),
		scheduledAt: integer({ mode: 'timestamp_ms' }),
		publishedAt: integer({ mode: 'timestamp_ms' }),
		/**
		 * Google posts (#135): `STANDARD` (update) | `OFFER` | `EVENT`; null for
		 * Facebook and Instagram. `googleDetails` is JSON `GooglePostDetails`
		 * (button, offer, event fields), validated by `google-post.ts`.
		 */
		googleTopicType: text(),
		googleDetails: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('SocialPost_organizationId_scheduledAt_idx').on(
			table.organizationId,
			table.scheduledAt,
		),
		index('SocialPost_status_scheduledAt_idx').on(
			table.status,
			table.scheduledAt,
		),
	],
)

// One row per account a post goes to. The platform and account name are
// copied so the history stays readable after the account is disconnected.
export const SocialPostTarget = sqliteTable(
	'SocialPostTarget',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		postId: text()
			.notNull()
			.references(() => SocialPost.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		socialAccountId: text().references(() => SocialAccount.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		platform: text().notNull(),
		accountName: text().notNull(),
		// pending | publishing | published | failed
		status: text().default('pending').notNull(),
		externalPostId: text(),
		permalink: text(),
		error: text(),
		/**
		 * Google posts (#135): Google may hold a post for review. `pending` until
		 * the hourly sweep sees it `live` or `rejected`; null elsewhere.
		 */
		reviewState: text(),
		attempts: integer().default(0).notNull(),
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
		index('SocialPostTarget_postId_idx').on(table.postId),
		index('SocialPostTarget_socialAccountId_idx').on(table.socialAccountId),
	],
)

// Discounts and coupons (docs/discounts-plan.md). Definitions hold menu ids and
// rules only, never customer data; usage is counted in the regional tenant DB.
// The nested JSON columns are validated by `discountDefinitionSchema` in
// `@repo/discounts`, which is the single source of their shape.
export const Discount = sqliteTable(
	'Discount',
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
		// Default website language; nameI18n / descriptionI18n hold every
		// language (JSON maps, null when not translated).
		name: text().notNull(),
		nameI18n: text(),
		internalName: text(),
		description: text(),
		descriptionI18n: text(),
		// active | paused | archived. Never deleted: redemptions reference it.
		status: text().default('active').notNull(),
		// automatic | code | manual
		application: text().notNull(),
		// percent | fixed | free_delivery
		valueType: text().notNull(),
		percentBp: integer(),
		amountMinor: integer(),
		currency: text(),
		maxDiscountMinor: integer(),
		target: text().notNull(),
		requirement: text(),
		quantityRule: text().default('{"kind":"none"}').notNull(),
		maxDiscountedUnits: integer(),
		minSubtotalMinor: integer(),
		// JSON array of location ids; null means every location.
		locationIds: text(),
		channels: text().default('["web","qr","pos","app"]').notNull(),
		fulfillments: text().default('["pickup","delivery","dine_in"]').notNull(),
		includeDrops: integer({ mode: 'boolean' }).default(false).notNull(),
		schedule: text(),
		// Local date-times (YYYY-MM-DDTHH:MM) in each location's time zone.
		startsAt: text(),
		endsAt: text(),
		eligibility: text().default('everyone').notNull(),
		totalLimit: integer(),
		perCustomerLimit: text(),
		combinable: integer({ mode: 'boolean' }).default(false).notNull(),
		// JSON array of the kinds it may stack with (item, order, delivery). Null:
		// `combinable` decides (all kinds, or none).
		combinesWith: text(),
		// JSON spend or quantity ladder; null means none.
		tiers: text(),
		// Free delivery only: the largest delivery fee it waives.
		maxDeliveryFeeMinor: integer(),
		// 'cheapest' when the item limit covers the cheapest eligible item first
		// (#395); null is the dearest first, as it always was.
		itemChoice: text(),
		// Weekly spend limit (#392), minor units of `currency`. Null is none.
		weeklyBudgetMinor: integer(),
		// Saved audience (#415): a `marketing_audiences` id in the region. Only the
		// id is kept here; membership is read in the guest's region.
		audienceId: text(),
		// When this discount applies to an order, the packaging fee (#408) is waived.
		waivesPackagingFee: integer({ mode: 'boolean' }).default(false).notNull(),
		priority: integer().default(0).notNull(),
		promoteOnMenu: integer({ mode: 'boolean' }).default(false).notNull(),
		requireApproval: integer({ mode: 'boolean' }).default(false).notNull(),
		// Bumped on every save; a redemption freezes the version it used.
		version: integer().default(1).notNull(),
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
		index('Discount_organizationId_status_idx').on(
			table.organizationId,
			table.status,
		),
	],
)

export const DiscountCode = sqliteTable(
	'DiscountCode',
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
		discountId: text()
			.notNull()
			.references(() => Discount.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		// As the operator typed it.
		code: text().notNull(),
		// Upper case, no spaces or dashes: what is compared and rate limited.
		normalizedCode: text().notNull(),
		maxUses: integer(),
		archivedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('DiscountCode_discountId_idx').on(table.discountId),
		// A code is unique per organization among the unarchived ones.
		uniqueIndex('DiscountCode_organizationId_normalizedCode_active_key')
			.on(table.organizationId, table.normalizedCode)
			.where(sql`${table.archivedAt} IS NULL`),
	],
)

/**
 * Gift card settings (#110, #214, #218): presets, bounds, expiry, designs and
 * purchase limits, one row per organization. Settings only: no card, code,
 * balance or person lives in the control plane (they stay in the region). The
 * JSON is `giftCardSettingsSchema` in `@repo/common/gift-cards`; an
 * organization with no row uses the defaults.
 */
export const GiftCardSettings = sqliteTable('GiftCardSettings', {
	organizationId: text()
		.primaryKey()
		.references(() => Organization.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
	settings: text().notNull(),
	updatedById: text().references(() => User.id, {
		onDelete: 'set null',
		onUpdate: 'cascade',
	}),
	updatedAt: integer({ mode: 'timestamp_ms' })
		.$defaultFn(() => new Date())
		.$onUpdate(() => new Date())
		.notNull(),
})

/**
 * A restaurant's own saved email layout (#154): a name and the designer's
 * blocks, nothing else. No audience, no coupon, no schedule: merge tags stay as
 * tags, and starting from a template copies it, so editing one later never
 * changes a message already saved or sent. Blocks hold no guest data.
 */
export const MarketingEmailTemplate = sqliteTable(
	'MarketingEmailTemplate',
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
		// `emailBlocksSchema` JSON (`@repo/common/email-blocks`).
		blocks: text().notNull(),
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
		// One name per organization (`template_name_taken`).
		uniqueIndex('MarketingEmailTemplate_organizationId_name_key').on(
			table.organizationId,
			table.name,
		),
	],
)

/**
 * Local search keywords (#182), up to ten per location, one primary. A
 * removed keyword is soft-deleted (`deletedAt`) and its history purged after
 * 90 days. Business data only.
 */
export const SeoKeyword = sqliteTable(
	'SeoKeyword',
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
		organizationLocationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		/** Lower-cased, 2 to 80 characters. */
		phrase: text().notNull(),
		/** `en` or `ar`: the language the check runs in. */
		locale: text().default('en').notNull(),
		isPrimary: integer({ mode: 'boolean' }).default(false).notNull(),
		/** `home`, `location:<id>`, `dish:<id>` or `page:<id>`; a hint only. */
		pageRef: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		deletedAt: integer({ mode: 'timestamp_ms' }),
	},
	(table) => [
		index('SeoKeyword_organizationId_idx').on(table.organizationId),
		uniqueIndex('SeoKeyword_location_phrase_key')
			.on(table.organizationLocationId, table.phrase)
			.where(sql`${table.deletedAt} IS NULL`),
	],
)

/**
 * One local rank check (#182): the location's position in map results at
 * each point of a grid, and their average. `status` is `ok`, `skipped`
 * (with `reason`, e.g. `budget_exhausted`) or `failed`.
 */
export const SeoRankCheck = sqliteTable(
	'SeoRankCheck',
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
		keywordId: text()
			.notNull()
			.references(() => SeoKeyword.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		checkedAt: integer({ mode: 'timestamp_ms' }).notNull(),
		status: text().default('ok').notNull(),
		reason: text(),
		gridSize: integer().default(5).notNull(),
		spacingMeters: integer().default(1000).notNull(),
		averageRank: real(),
		/** JSON `[{ lat, lng, rank }]`, rank null when not in the top 20. */
		points: text().default('[]').notNull(),
	},
	(table) => [
		index('SeoRankCheck_keywordId_checkedAt_idx').on(
			table.keywordId,
			table.checkedAt,
		),
		index('SeoRankCheck_organizationId_idx').on(table.organizationId),
	],
)

/** Rank checks used per organization per month (`YYYY-MM`), for the budget. */
export const SeoUsage = sqliteTable(
	'SeoUsage',
	{
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		month: text().notNull(),
		checks: integer().default(0).notNull(),
		skipped: integer().default(0).notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.organizationId, table.month],
			name: 'SeoUsage_organizationId_month_pk',
		}),
	],
)

/**
 * Delivery area pages (#137): `/delivery/<slug>` for a named delivery zone.
 * A zone without a row still gets a page (generated slug, no intro, noindex);
 * the row stores the operator's intro, slug and switch.
 */
export const SiteAreaPage = sqliteTable(
	'SiteAreaPage',
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
		organizationLocationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		zoneId: text().notNull(),
		slug: text().notNull(),
		/** Localized JSON text. Empty: the page is noindex. */
		intro: text(),
		enabled: integer({ mode: 'boolean' }).default(true).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('SiteAreaPage_organizationId_slug_key').on(
			table.organizationId,
			table.slug,
		),
		uniqueIndex('SiteAreaPage_location_zone_key').on(
			table.organizationLocationId,
			table.zoneId,
		),
	],
)

/**
 * Website events (#184): announced, not booked. Wall-clock start and end of
 * the first occurrence in `timezone`, a repeat rule and exceptions (JSON,
 * `@repo/common/site-events`). Public marketing content only.
 */
export const SiteEvent = sqliteTable(
	'SiteEvent',
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
		organizationLocationId: text().references(() => OrganizationLocation.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		slug: text().notNull(),
		/** `draft` or `published`. */
		status: text().default('draft').notNull(),
		/** Localized JSON text. */
		title: text().notNull(),
		description: text(),
		imageUrl: text(),
		linkUrl: text(),
		linkLabel: text(),
		/** An opaque reservations experience id; its button shows only while booking is on. */
		experienceId: text(),
		startLocal: text().notNull(),
		endLocal: text().notNull(),
		timezone: text().notNull(),
		recurrence: text().default('{"frequency":"none"}').notNull(),
		exceptions: text().default('{"skipped":[],"moved":[]}').notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('SiteEvent_organizationId_slug_key').on(
			table.organizationId,
			table.slug,
		),
		index('SiteEvent_organizationId_status_idx').on(
			table.organizationId,
			table.status,
		),
	],
)

/** Search Console totals per day (#138), aggregate only. */
export const SearchConsoleDaily = sqliteTable(
	'SearchConsoleDaily',
	{
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		date: text().notNull(),
		clicks: integer().default(0).notNull(),
		impressions: integer().default(0).notNull(),
		position: real(),
	},
	(table) => [
		primaryKey({
			columns: [table.organizationId, table.date],
			name: 'SearchConsoleDaily_organizationId_date_pk',
		}),
	],
)

/**
 * Top search queries and pages for the last 28 days (#138), replaced on every
 * daily fetch. `kind` is `query` or `page`.
 */
export const SearchConsoleTop = sqliteTable(
	'SearchConsoleTop',
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
		kind: text().notNull(),
		value: text().notNull(),
		clicks: integer().default(0).notNull(),
		impressions: integer().default(0).notNull(),
		position: real(),
		fetchedAt: integer({ mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [
		index('SearchConsoleTop_organizationId_kind_idx').on(
			table.organizationId,
			table.kind,
		),
	],
)

/** When each URL was last sent to IndexNow (#138): once per URL per hour. */
export const IndexNowPing = sqliteTable(
	'IndexNowPing',
	{
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		url: text().notNull(),
		lastPingedAt: integer({ mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.organizationId, table.url],
			name: 'IndexNowPing_organizationId_url_pk',
		}),
	],
)

// ---------------------------------------------------------------------------
// Google Business Profile (#87, #284, #209, #208, #199, #135, #136)
// Business data only; no guest data. Docs: docs/google-business-profile.md
// ---------------------------------------------------------------------------

/**
 * The link between one Menuza location and one Google listing, plus the sync
 * state of everything Menuza keeps on it. `googleLocationName` is unique
 * across the platform: a Google location belongs to one Menuza location.
 */
export const GbpLocationSync = sqliteTable(
	'GbpLocationSync',
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
		organizationLocationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		integrationId: text().references(() => Integration.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		googleLocationName: text().notNull(),
		googleAccountName: text(),
		/** "Keep Google in sync": push the fields in `fieldsSynced` on change. */
		syncEnabled: integer({ mode: 'boolean' }).default(false).notNull(),
		/** JSON array of `GbpSyncField`; the fields the operator opted in to. */
		fieldsSynced: text().notNull(),
		// ok | not_verified | suspended | access_lost | token_expired
		state: text().default('ok').notNull(),
		lastPulledAt: integer({ mode: 'timestamp_ms' }),
		lastPushedAt: integer({ mode: 'timestamp_ms' }),
		/** JSON: what Google showed at the last pull. */
		lastGoogleSnapshot: text(),
		lastError: text(),
		/**
		 * JSON `Record<field, { fingerprint, attemptedAt, status, reason? }>`:
		 * the outbox bookkeeping. The same fingerprint is not sent again within
		 * an hour (quota rule); a changed value is a new attempt.
		 */
		fieldState: text(),
		/** Outbox: set when Menuza changed something that should reach Google. */
		pushRequestedAt: integer({ mode: 'timestamp_ms' }),
		/** Order link removed by a long ordering pause; restored on resume. */
		orderLinkPausedAt: integer({ mode: 'timestamp_ms' }),
		// Verification (#284). unknown | verified | unverified | pending
		verificationState: text().default('unknown').notNull(),
		verificationMethod: text(),
		verificationDestination: text(),
		verificationName: text(),
		verificationRequestedAt: integer({ mode: 'timestamp_ms' }),
		verificationCheckedAt: integer({ mode: 'timestamp_ms' }),
		/** JSON: methods Google offered at the last look. */
		verificationOptions: text(),
		// Menu (#208)
		menuSyncEnabled: integer({ mode: 'boolean' }).default(false).notNull(),
		/** Set when the menu changed; the next allowed publish picks it up. */
		menuDirtyAt: integer({ mode: 'timestamp_ms' }),
		menuPublishedAt: integer({ mode: 'timestamp_ms' }),
		menuAttemptedAt: integer({ mode: 'timestamp_ms' }),
		menuHash: text(),
		/** JSON: Google's answer and what was left out, with reasons. */
		menuPublishResult: text(),
		// Metrics (#136)
		metricsBackfilledAt: integer({ mode: 'timestamp_ms' }),
		metricsDataUntil: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('GbpLocationSync_organizationLocationId_key').on(
			table.organizationLocationId,
		),
		uniqueIndex('GbpLocationSync_googleLocationName_key').on(
			table.googleLocationName,
		),
		index('GbpLocationSync_organizationId_idx').on(table.organizationId),
	],
)

/** A difference between Menuza and Google (Needs attention item). */
export const GbpListingIssue = sqliteTable(
	'GbpListingIssue',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		syncId: text()
			.notNull()
			.references(() => GbpLocationSync.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		organizationLocationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		field: text().notNull(),
		/** JSON of the canonical value on each side. */
		menuzaValue: text(),
		googleValue: text(),
		// open | resolved | ignored | pending_google
		status: text().default('open').notNull(),
		resolvedById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		resolvedAt: integer({ mode: 'timestamp_ms' }),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('GbpListingIssue_syncId_field_idx').on(table.syncId, table.field),
		index('GbpListingIssue_organizationId_status_idx').on(
			table.organizationId,
			table.status,
		),
	],
)

/** Append-only history of what was sent to or read from Google. */
export const GbpSyncEvent = sqliteTable(
	'GbpSyncEvent',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		syncId: text().references(() => GbpLocationSync.id, {
			onDelete: 'cascade',
			onUpdate: 'cascade',
		}),
		organizationId: text()
			.notNull()
			.references(() => Organization.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		organizationLocationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		// push | pull | resolve | verify | menu | media | attributes | links
		kind: text().notNull(),
		field: text(),
		/** The member who did it; null for the sweep or a save-triggered push. */
		actorId: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		summary: text().notNull(),
		/** JSON: what was sent (`updateMask`, body). */
		request: text(),
		// accepted | pending_google | rejected | failed | skipped
		result: text().notNull(),
		/** Google's answer or reason, trimmed. */
		response: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index('GbpSyncEvent_organizationLocationId_createdAt_idx').on(
			table.organizationLocationId,
			table.createdAt,
		),
	],
)

/** Hand-set profile fields (#209): description, opening date, attributes. */
export const GoogleProfileField = sqliteTable(
	'GoogleProfileField',
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
		organizationLocationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		/** `description`, `openingDate` or `attr:<attributeName>`. */
		key: text().notNull(),
		/** JSON value. */
		value: text().notNull(),
		// hand | derived
		source: text().default('hand').notNull(),
		// saved | pending | rejected
		status: text().default('saved').notNull(),
		reason: text(),
		pendingSince: integer({ mode: 'timestamp_ms' }),
		updatedById: text().references(() => User.id, {
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
		uniqueIndex('GoogleProfileField_location_key_key').on(
			table.organizationLocationId,
			table.key,
		),
	],
)

/** Photos Menuza put on (or refused for) the profile (#208). */
export const GoogleMediaUpload = sqliteTable(
	'GoogleMediaUpload',
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
		organizationLocationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		mediaId: text().notNull(),
		// FOOD_AND_DRINK | COVER | PROFILE
		category: text().notNull(),
		remoteName: text(),
		// chosen | uploaded | skipped | failed | removed
		status: text().default('chosen').notNull(),
		reason: text(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('GoogleMediaUpload_location_media_category_key').on(
			table.organizationLocationId,
			table.mediaId,
			table.category,
		),
	],
)

/**
 * Place Actions links seen on the profile (#199). Rows are a snapshot per
 * check; `state` keeps what a "Make Menuza preferred" change replaced so Undo
 * can put it back (`changeId` groups one confirmation).
 */
export const ListingOrderLink = sqliteTable(
	'ListingOrderLink',
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
		organizationLocationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		// order | pickup | delivery | reservation
		kind: text().notNull(),
		url: text().notNull(),
		/** Provider name from the domain list, or the host. */
		provider: text().notNull(),
		// direct | delivery_app | other
		classification: text().notNull(),
		isPreferred: integer({ mode: 'boolean' }).default(false).notNull(),
		googleLinkName: text(),
		/** Google's own provider type; MERCHANT links can be edited. */
		googleProviderType: text(),
		editable: integer({ mode: 'boolean' }).default(true).notNull(),
		// current | superseded | removed
		state: text().default('current').notNull(),
		changeId: text(),
		checkedAt: integer({ mode: 'timestamp_ms' }).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index('ListingOrderLink_location_state_idx').on(
			table.organizationLocationId,
			table.state,
		),
	],
)

/** Daily Google listing totals per location (#136). */
export const GbpDailyMetric = sqliteTable(
	'GbpDailyMetric',
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
		organizationLocationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		/** `YYYY-MM-DD` (Google's day). */
		date: text().notNull(),
		metric: text().notNull(),
		value: integer().notNull(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('GbpDailyMetric_location_date_metric_key').on(
			table.organizationLocationId,
			table.date,
			table.metric,
		),
		index('GbpDailyMetric_organizationId_date_idx').on(
			table.organizationId,
			table.date,
		),
	],
)

/** Top monthly search phrases (#136). Below Google's threshold: a range. */
export const GbpSearchKeyword = sqliteTable(
	'GbpSearchKeyword',
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
		organizationLocationId: text()
			.notNull()
			.references(() => OrganizationLocation.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		/** `YYYY-MM`. */
		month: text().notNull(),
		keyword: text().notNull(),
		/** The count, or null when Google gave only `threshold`. */
		value: integer(),
		/** Google's "< n" privacy bound, shown as given. */
		threshold: integer(),
		updatedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('GbpSearchKeyword_location_month_keyword_key').on(
			table.organizationLocationId,
			table.month,
			table.keyword,
		),
	],
)

/**
 * The branded customer app of an organization (#156, #196). One record per
 * organization, created in Admin from the published website's branding. It holds
 * public branding, bundle ids, store links and the invite placement switches;
 * never guest data. Bundle ids are unique across all apps and, once
 * `publishedAt` is set, immutable. Deleting is allowed only before the first
 * publish; afterwards the app is archived. Push credentials are in
 * `CustomerAppCredential` (encrypted, write-only).
 */
export const CustomerApp = sqliteTable(
	'CustomerApp',
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
		/** Build slug (`tenants/<slug>`); also the app's URL scheme suffix. */
		slug: text().notNull(),
		displayName: text().notNull(),
		iosBundleId: text().notNull(),
		androidPackage: text().notNull(),
		marketingVersion: text().default('1.0.0').notNull(),
		status: text({ enum: ['draft', 'published', 'archived'] })
			.default('draft')
			.notNull(),
		/** `menuza`: Menuza's developer account. `restaurant`: the restaurant's own. */
		publisher: text({ enum: ['menuza', 'restaurant'] })
			.default('menuza')
			.notNull(),
		iconBackground: text().default('#0F172A').notNull(),
		/** Store listing text (subtitle, description) as JSON the staff edit. */
		listingText: text(),
		/** JSON `{ app_store?: url, play_store?: url }`; only validated store links. */
		storeUrls: text(),
		/** Apple team id and Android signing fingerprints for the app-link files (#195). */
		appleTeamId: text(),
		androidSha256: text(),
		/** JSON account facts (expiry, terms, payment terms, access) the checks read. */
		accountSnapshot: text(),
		accountCheckedAt: integer({ mode: 'timestamp_ms' }),
		/** Set when a store first goes live. Locks the bundle ids. */
		publishedAt: integer({ mode: 'timestamp_ms' }),
		archivedAt: integer({ mode: 'timestamp_ms' }),
		/** Invite placements on the website (#196); nothing shows until a store is live. */
		inviteBanner: integer({ mode: 'boolean' }).default(true).notNull(),
		inviteConfirmation: integer({ mode: 'boolean' }).default(true).notNull(),
		inviteFooter: integer({ mode: 'boolean' }).default(true).notNull(),
		inviteBannerText: text().default('').notNull(),
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
		uniqueIndex('CustomerApp_organizationId_key').on(table.organizationId),
		uniqueIndex('CustomerApp_slug_key').on(table.slug),
		uniqueIndex('CustomerApp_iosBundleId_key').on(table.iosBundleId),
		uniqueIndex('CustomerApp_androidPackage_key').on(table.androidPackage),
	],
)

/**
 * A push credential of one app: the APNs key or the Firebase service account.
 * `ciphertext` is encrypted with INTEGRATION_ENCRYPTION_KEY and is never
 * selected by any loader or returned by any API: the only reader is the push
 * credential check in `customer-apps/credentials.server.ts`. Callers learn
 * whether a credential is set, and when it was uploaded.
 */
export const CustomerAppCredential = sqliteTable(
	'CustomerAppCredential',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		appId: text()
			.notNull()
			.references(() => CustomerApp.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		kind: text({ enum: ['apns', 'fcm'] }).notNull(),
		ciphertext: text().notNull(),
		uploadedById: text().references(() => User.id, {
			onDelete: 'set null',
			onUpdate: 'cascade',
		}),
		uploadedAt: integer({ mode: 'timestamp_ms' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex('CustomerAppCredential_appId_kind_key').on(
			table.appId,
			table.kind,
		),
	],
)

/**
 * One build of one app on one platform for a release. A retry reuses the row
 * (`attempts` counts), so one app's failure never touches the others. A build
 * is a recorded job plus status callbacks, not a live EAS or store submission.
 */
export const CustomerAppBuild = sqliteTable(
	'CustomerAppBuild',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		appId: text()
			.notNull()
			.references(() => CustomerApp.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		release: text().notNull(),
		platform: text({ enum: ['ios', 'android'] }).notNull(),
		status: text({
			enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
		})
			.default('queued')
			.notNull(),
		attempts: integer().default(1).notNull(),
		externalBuildId: text(),
		logUrl: text(),
		/** The organization's data region when the build started (#156 region change). */
		dataRegion: text().default('us').notNull(),
		/** A short machine reason on failure; never a log. */
		error: text(),
		startedById: text().references(() => User.id, {
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
		finishedAt: integer({ mode: 'timestamp_ms' }),
	},
	(table) => [
		uniqueIndex('CustomerAppBuild_appId_release_platform_key').on(
			table.appId,
			table.release,
			table.platform,
		),
		index('CustomerAppBuild_appId_createdAt_idx').on(
			table.appId,
			table.createdAt,
		),
	],
)

/**
 * Last known state of one app in one store. Read on a schedule (at most daily);
 * a store that cannot be reached keeps its last known state and only
 * `lastError` changes.
 */
export const CustomerAppStoreHealth = sqliteTable(
	'CustomerAppStoreHealth',
	{
		appId: text()
			.notNull()
			.references(() => CustomerApp.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		store: text({ enum: ['app_store', 'play_store'] }).notNull(),
		status: text({ enum: ['live', 'removed', 'unknown'] })
			.default('unknown')
			.notNull(),
		version: text(),
		/** Stars times 100. */
		ratingX100: integer(),
		ratingCount: integer().default(0).notNull(),
		lastCheckedAt: integer({ mode: 'timestamp_ms' }),
		lastSuccessAt: integer({ mode: 'timestamp_ms' }),
		/** Short machine code of the last failed check, cleared on success. */
		lastError: text(),
	},
	(table) => [primaryKey({ columns: [table.appId, table.store] })],
)

/** Latest public store reviews, read-only (replying is out of scope). */
export const CustomerAppStoreReview = sqliteTable(
	'CustomerAppStoreReview',
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId())
			.notNull(),
		appId: text()
			.notNull()
			.references(() => CustomerApp.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		store: text({ enum: ['app_store', 'play_store'] }).notNull(),
		externalId: text().notNull(),
		rating: integer().notNull(),
		title: text(),
		body: text().notNull(),
		appVersion: text(),
		reviewedAt: integer({ mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [
		uniqueIndex('CustomerAppStoreReview_app_store_external_key').on(
			table.appId,
			table.store,
			table.externalId,
		),
		index('CustomerAppStoreReview_appId_reviewedAt_idx').on(
			table.appId,
			table.reviewedAt,
		),
	],
)

/** Taps on the "Get the app" placements, per app, placement, store and day (#196). No visitor data. */
export const CustomerAppTap = sqliteTable(
	'CustomerAppTap',
	{
		appId: text()
			.notNull()
			.references(() => CustomerApp.id, {
				onDelete: 'cascade',
				onUpdate: 'cascade',
			}),
		placement: text().notNull(),
		store: text().notNull(),
		/** `YYYY-MM-DD` (UTC). */
		day: text().notNull(),
		count: integer().default(0).notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.appId, table.placement, table.store, table.day],
		}),
	],
)
