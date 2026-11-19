import { auditService, AuditAction } from '@repo/audit'
import { and, AuditLog, db, desc, eq, inArray, User } from '@repo/database'

/**
 * Website changes shown in Website, Activity (#85): publish, unpublish,
 * restore, discard, delete, schedule, redirect and domain changes. They are
 * ordinary `AuditLog` entries (no second log); this list is what the screen
 * reads back.
 */
export const WEBSITE_ACTIVITY_ACTIONS = [
	AuditAction.WEBSITE_PAGE_PUBLISHED,
	AuditAction.WEBSITE_PAGE_UNPUBLISHED,
	AuditAction.WEBSITE_PAGE_DELETED,
	AuditAction.WEBSITE_PAGE_RESTORED,
	AuditAction.WEBSITE_VERSION_RESTORED,
	AuditAction.WEBSITE_DRAFT_DISCARDED,
	AuditAction.WEBSITE_SITE_DESIGN_PUBLISHED,
	AuditAction.WEBSITE_PUBLISH_SCHEDULED,
	AuditAction.WEBSITE_SCHEDULE_CANCELLED,
	AuditAction.WEBSITE_SCHEDULED_PUBLISH_RAN,
	AuditAction.WEBSITE_SCHEDULED_PUBLISH_FAILED,
	AuditAction.WEBSITE_REDIRECT_CREATED,
	AuditAction.WEBSITE_REDIRECT_UPDATED,
	AuditAction.WEBSITE_REDIRECT_DELETED,
	AuditAction.WEBSITE_DOMAIN_CHANGED,
	AuditAction.WEBSITE_LEGAL_PAGES_GENERATED,
	AuditAction.WEBSITE_LEGAL_PAGE_REGENERATED,
] as const

export type WebsiteActivityMetadata = {
	pageId?: string | null
	pageTitle?: string | null
	versionId?: string | null
	[key: string]: unknown
}

/**
 * Records one website change. Never throws: a failed log line must not undo
 * or block the change itself.
 */
export async function logWebsiteActivity(input: {
	action: (typeof WEBSITE_ACTIVITY_ACTIONS)[number]
	organizationId: string
	userId: string | null
	details: string
	metadata?: WebsiteActivityMetadata
	request?: Request
}) {
	try {
		await auditService.log({
			action: input.action,
			userId: input.userId,
			organizationId: input.organizationId,
			details: input.details,
			resourceType: 'website',
			resourceId: input.metadata?.pageId ?? input.organizationId,
			metadata: input.metadata,
			request: input.request,
		})
	} catch (error) {
		console.error('website activity log failed', {
			action: input.action,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export type WebsiteActivityEntry = {
	id: string
	action: string
	details: string
	at: string
	userName: string | null
	pageId: string | null
	pageTitle: string | null
}

/** The newest website changes of an organization, with who made them. */
export async function listWebsiteActivity(
	organizationId: string,
	limit = 100,
): Promise<WebsiteActivityEntry[]> {
	const rows = await db
		.select({
			id: AuditLog.id,
			action: AuditLog.action,
			details: AuditLog.details,
			metadata: AuditLog.metadata,
			createdAt: AuditLog.createdAt,
			userId: AuditLog.userId,
		})
		.from(AuditLog)
		.where(
			and(
				eq(AuditLog.organizationId, organizationId),
				inArray(AuditLog.action, [...WEBSITE_ACTIVITY_ACTIONS]),
			),
		)
		.orderBy(desc(AuditLog.createdAt))
		.limit(limit)
	const userIds = [
		...new Set(
			rows.map((row) => row.userId).filter((id): id is string => !!id),
		),
	]
	const users = userIds.length
		? await db
				.select({ id: User.id, name: User.name, username: User.username })
				.from(User)
				.where(inArray(User.id, userIds))
		: []
	const nameOf = new Map(users.map((u) => [u.id, u.name || u.username]))
	return rows.map((row) => {
		let metadata: WebsiteActivityMetadata = {}
		try {
			metadata = row.metadata
				? (JSON.parse(row.metadata) as WebsiteActivityMetadata)
				: {}
		} catch {
			metadata = {}
		}
		return {
			id: row.id,
			action: row.action,
			details: row.details,
			at: row.createdAt.toISOString(),
			userName: row.userId ? (nameOf.get(row.userId) ?? null) : null,
			pageId: typeof metadata.pageId === 'string' ? metadata.pageId : null,
			pageTitle:
				typeof metadata.pageTitle === 'string' ? metadata.pageTitle : null,
		}
	})
}
