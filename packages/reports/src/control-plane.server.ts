import {
	and,
	AuditLog,
	db,
	desc,
	eq,
	Feedback,
	exists,
	isNull,
	NoteAccess,
	or,
	Organization,
	OrganizationNote,
	OrganizationNoteStatus,
	OrganizationRole,
	SavedReport,
	Session,
	User,
	UserOrganization,
	WaitlistEntry,
} from '@repo/database'
import { type ReportDefinition, reportDefinitionSchema } from './dsl.ts'
import { type ReportRecord } from './engine.ts'

export function parseDefinition(raw: unknown): ReportDefinition {
	if (typeof raw === 'string') {
		return reportDefinitionSchema.parse(JSON.parse(raw))
	}
	return reportDefinitionSchema.parse(raw)
}

export async function fetchControlPlaneRecords(options: {
	subject: string
	scope: 'organization' | 'platform'
	organizationId?: string
	/**
	 * The member running an organization report. Notes follow the notes-list
	 * rule for them: public notes, their own, and notes shared with them.
	 * Without it an organization notes report returns nothing.
	 */
	viewerUserId?: string
}): Promise<ReportRecord[]> {
	const { subject, scope, organizationId, viewerUserId } = options

	if (scope === 'organization') {
		if (!organizationId) return []
		if (subject === 'notes') {
			if (!viewerUserId) return []
			const rows = await db
				.select({
					createdAt: OrganizationNote.createdAt,
					updatedAt: OrganizationNote.updatedAt,
					title: OrganizationNote.title,
					priority: OrganizationNote.priority,
					isPublic: OrganizationNote.isPublic,
					status: OrganizationNoteStatus.name,
				})
				.from(OrganizationNote)
				.leftJoin(
					OrganizationNoteStatus,
					eq(OrganizationNote.statusId, OrganizationNoteStatus.id),
				)
				.where(
					and(
						eq(OrganizationNote.organizationId, organizationId),
						or(
							eq(OrganizationNote.isPublic, true),
							eq(OrganizationNote.createdById, viewerUserId),
							exists(
								db
									.select({ noteId: NoteAccess.noteId })
									.from(NoteAccess)
									.where(
										and(
											eq(NoteAccess.noteId, OrganizationNote.id),
											eq(NoteAccess.userId, viewerUserId),
										),
									),
							),
						),
					),
				)
			return rows
		}
		if (subject === 'members') {
			const rows = await db
				.select({
					createdAt: UserOrganization.createdAt,
					name: User.name,
					email: User.email,
					role: OrganizationRole.name,
					department: UserOrganization.department,
					active: UserOrganization.active,
				})
				.from(UserOrganization)
				.innerJoin(
					OrganizationRole,
					eq(UserOrganization.organizationRoleId, OrganizationRole.id),
				)
				.innerJoin(User, eq(UserOrganization.userId, User.id))
				// Same as the Members page: active members only.
				.where(
					and(
						eq(UserOrganization.organizationId, organizationId),
						eq(UserOrganization.active, true),
					),
				)
			return rows
		}
		if (subject === 'feedback') {
			const rows = await db
				.select({
					createdAt: Feedback.createdAt,
					type: Feedback.type,
				})
				.from(Feedback)
				.where(eq(Feedback.organizationId, organizationId))
			return rows
		}
		return []
	}

	if (subject === 'organizations') {
		return db
			.select({
				createdAt: Organization.createdAt,
				name: Organization.name,
				slug: Organization.slug,
				dataRegion: Organization.dataRegion,
				active: Organization.active,
				sitePublished: Organization.sitePublished,
				subscriptionStatus: Organization.subscriptionStatus,
				planName: Organization.planName,
			})
			.from(Organization)
	}
	if (subject === 'users') {
		return db
			.select({
				createdAt: User.createdAt,
				name: User.name,
				username: User.username,
				email: User.email,
				isBanned: User.isBanned,
			})
			.from(User)
	}
	if (subject === 'waitlist') {
		return db
			.select({
				createdAt: WaitlistEntry.createdAt,
				hasEarlyAccess: WaitlistEntry.hasEarlyAccess,
				hasJoinedDiscord: WaitlistEntry.hasJoinedDiscord,
			})
			.from(WaitlistEntry)
	}
	if (subject === 'feedback') {
		return db
			.select({
				createdAt: Feedback.createdAt,
				type: Feedback.type,
			})
			.from(Feedback)
	}
	if (subject === 'sessions') {
		return db.select({ createdAt: Session.createdAt }).from(Session)
	}
	if (subject === 'audit_logs') {
		return db
			.select({
				createdAt: AuditLog.createdAt,
				action: AuditLog.action,
				severity: AuditLog.severity,
			})
			.from(AuditLog)
	}
	return []
}

export async function listSavedReports(options: {
	scope: 'organization' | 'platform'
	organizationId?: string
}) {
	return db
		.select({
			id: SavedReport.id,
			title: SavedReport.title,
			updatedAt: SavedReport.updatedAt,
			definition: SavedReport.definition,
		})
		.from(SavedReport)
		.where(
			options.scope === 'organization'
				? eq(SavedReport.organizationId, options.organizationId ?? '')
				: and(
						eq(SavedReport.scope, 'platform'),
						isNull(SavedReport.organizationId),
					),
		)
		.orderBy(desc(SavedReport.updatedAt))
}

export async function getSavedReport(options: {
	id: string
	scope: 'organization' | 'platform'
	organizationId?: string
}) {
	const [report] = await db
		.select()
		.from(SavedReport)
		.where(
			and(
				eq(SavedReport.id, options.id),
				options.scope === 'organization'
					? eq(SavedReport.organizationId, options.organizationId ?? '')
					: and(
							eq(SavedReport.scope, 'platform'),
							isNull(SavedReport.organizationId),
						),
			),
		)
		.limit(1)
	return report ?? null
}

export async function saveReport(options: {
	id?: string
	scope: 'organization' | 'platform'
	organizationId?: string | null
	createdById: string
	definition: ReportDefinition
}) {
	const values = {
		scope: options.scope,
		organizationId: options.organizationId ?? null,
		createdById: options.createdById,
		title: options.definition.settings.title,
		notes: options.definition.settings.notes,
		definition: JSON.stringify(options.definition),
	}

	if (options.id) {
		const existing = await getSavedReport({
			id: options.id,
			scope: options.scope,
			organizationId: options.organizationId ?? undefined,
		})
		if (!existing) return null
		// The creator stays the creator: an update never reassigns ownership.
		const { createdById: ignoredCreatedById, ...updateValues } = values
		const [updated] = await db
			.update(SavedReport)
			.set(updateValues)
			.where(eq(SavedReport.id, options.id))
			.returning({ id: SavedReport.id })
		return updated ?? null
	}

	const [created] = await db
		.insert(SavedReport)
		.values(values)
		.returning({ id: SavedReport.id })
	return created ?? null
}
