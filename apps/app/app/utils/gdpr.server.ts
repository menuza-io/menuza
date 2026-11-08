import { auditService, AuditAction } from '@repo/audit'
import {
	alias,
	and,
	db,
	desc,
	eq,
	exists,
	gt,
	inArray,
	isNull,
	lte,
	ne,
	or,
	DataSubjectRequest,
	Organization,
	OrganizationRole,
	RefreshToken,
	Session,
	User,
	UserOrganization,
} from '@repo/database'
import { getClientIp } from '@repo/security'
import {
	enqueueStaffErasureForOrganizations,
	flushStaffErasure,
	staffErasureOrganizationIds,
} from '#app/utils/staffing/dsar.server.ts'

export const GDPR_DELETION_GRACE_PERIOD_DAYS = 7

export type DataSubjectRequestType = 'export' | 'erasure'

export interface GdprRequestResult {
	success: boolean
	requestId?: string
	error?: string
	scheduledFor?: Date
}

export interface UserDataExport {
	exportedAt: string
	userId: string
	schemaVersion: number
	user: {
		id: string
		email: string
		username: string
		name: string | null
		createdAt: Date
		updatedAt: Date
	}
	relations: {
		notes: Array<{
			id: string
			title: string
			content: string
			createdAt: Date
			updatedAt: Date
			images: Array<{
				id: string
				altText: string | null
				url: string
				createdAt: Date
			}>
		}>
		connections: Array<{
			id: string
			providerName: string
			createdAt: Date
		}>
		organizations: Array<{
			organizationId: string
			organizationName: string
			role: string
			joinedAt: Date
		}>
		sessions: Array<{
			id: string
			createdAt: Date
			expirationDate: Date
			ipAddress: string | null
			userAgent: string | null
		}>
		feedback: Array<{
			id: string
			type: string
			message: string
			createdAt: Date
		}>
	}
	files: {
		userImage: { objectKey: string; url: string } | null
		noteImages: Array<{ noteId: string; objectKey: string; url: string }>
	}
	statistics: {
		totalNotes: number
		totalConnections: number
		totalOrganizations: number
		totalSessions: number
		totalFeedback: number
	}
	redactions: string[]
}

/** Erasure request statuses that still lead to the account being deleted. */
export const ACTIVE_ERASURE_STATUSES = ['requested', 'processing', 'scheduled']

/**
 * An export is generated inside one request. One still `processing` after this
 * long belongs to a request that crashed or timed out, and must not block the
 * user's next export.
 */
export const EXPORT_STALE_PROCESSING_MS = 10 * 60 * 1000

async function getActiveRequest(
	userId: string,
	type: DataSubjectRequestType,
	now = new Date(),
): Promise<{ id: string; status: string; scheduledFor: Date | null } | null> {
	const staleBefore = new Date(now.getTime() - EXPORT_STALE_PROCESSING_MS)
	const [request] = await db
		.select({
			id: DataSubjectRequest.id,
			status: DataSubjectRequest.status,
			scheduledFor: DataSubjectRequest.scheduledFor,
		})
		.from(DataSubjectRequest)
		.where(
			and(
				eq(DataSubjectRequest.userId, userId),
				eq(DataSubjectRequest.type, type),
				type === 'export'
					? or(
							inArray(DataSubjectRequest.status, ['requested', 'scheduled']),
							and(
								eq(DataSubjectRequest.status, 'processing'),
								gt(DataSubjectRequest.processedAt, staleBefore),
							),
						)
					: inArray(DataSubjectRequest.status, ACTIVE_ERASURE_STATUSES),
			),
		)
		.limit(1)
	return request ?? null
}

/** Records that generating an export failed, so it no longer counts as active. */
export async function markExportRequestFailed(
	requestId: string,
	reason: string,
): Promise<void> {
	await db
		.update(DataSubjectRequest)
		.set({ status: 'failed', failureReason: reason.slice(0, 500) })
		.where(
			and(
				eq(DataSubjectRequest.id, requestId),
				eq(DataSubjectRequest.type, 'export'),
				eq(DataSubjectRequest.status, 'processing'),
			),
		)
}

type ErasureRequestOrder = { id: string; requestedAt: Date }

/** The earliest active erasure request of each user, by (requestedAt, id). */
async function oldestActiveErasureRequests(userIds: string[]) {
	const oldest = new Map<string, ErasureRequestOrder>()
	if (userIds.length === 0) return oldest
	const rows = await db
		.select({
			userId: DataSubjectRequest.userId,
			id: DataSubjectRequest.id,
			requestedAt: DataSubjectRequest.requestedAt,
		})
		.from(DataSubjectRequest)
		.where(
			and(
				inArray(DataSubjectRequest.userId, userIds),
				eq(DataSubjectRequest.type, 'erasure'),
				inArray(DataSubjectRequest.status, ACTIVE_ERASURE_STATUSES),
			),
		)
	for (const row of rows) {
		if (!row.userId) continue
		const current = oldest.get(row.userId)
		if (!current || isErasureRequestOlder(row, current)) {
			oldest.set(row.userId, { id: row.id, requestedAt: row.requestedAt })
		}
	}
	return oldest
}

function isErasureRequestOlder(a: ErasureRequestOrder, b: ErasureRequestOrder) {
	const byTime = a.requestedAt.getTime() - b.requestedAt.getTime()
	return byTime !== 0 ? byTime < 0 : a.id < b.id
}

/**
 * Organizations where `userId` is an active admin and no other active admin
 * would remain. An admin who has an erasure request of their own pending is
 * leaving too, so they do not count as the other admin.
 *
 * When every other admin is leaving too, the oldest request (by requestedAt,
 * then id) goes ahead and the others wait: otherwise two leaving admins would
 * hold each other's erasure forever. Once it is done, the admins left are the
 * organization's sole admins and wait for another admin as usual. A user with
 * no erasure request yet is never the oldest, so a new request is still
 * refused while the other admins are all leaving.
 */
export async function findSoleAdminOrganizations(
	userId: string,
): Promise<Array<{ organizationId: string; name: string }>> {
	const adminMemberships = await db
		.select({
			organizationId: UserOrganization.organizationId,
			name: Organization.name,
		})
		.from(UserOrganization)
		.innerJoin(
			OrganizationRole,
			eq(UserOrganization.organizationRoleId, OrganizationRole.id),
		)
		.innerJoin(
			Organization,
			eq(UserOrganization.organizationId, Organization.id),
		)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				// An inactive membership cannot be the sole active admin.
				eq(UserOrganization.active, true),
				eq(OrganizationRole.name, 'admin'),
				isNull(OrganizationRole.organizationId),
			),
		)
	if (adminMemberships.length === 0) return []

	const ownRequest = (await oldestActiveErasureRequests([userId])).get(userId)
	const OtherMembership = alias(UserOrganization, 'otherMembership')
	const blocking: Array<{ organizationId: string; name: string }> = []
	for (const membership of adminMemberships) {
		const otherAdmins = await db
			.select({ userId: OtherMembership.userId })
			.from(OtherMembership)
			.innerJoin(
				OrganizationRole,
				eq(OtherMembership.organizationRoleId, OrganizationRole.id),
			)
			.where(
				and(
					eq(OtherMembership.organizationId, membership.organizationId),
					eq(OtherMembership.active, true),
					ne(OtherMembership.userId, userId),
					eq(OrganizationRole.name, 'admin'),
					isNull(OrganizationRole.organizationId),
				),
			)
		const otherRequests = await oldestActiveErasureRequests(
			otherAdmins.map((admin) => admin.userId),
		)
		const anAdminStays = otherAdmins.some(
			(admin) => !otherRequests.has(admin.userId),
		)
		if (anAdminStays) continue
		const oldestLeaving =
			ownRequest !== undefined &&
			otherAdmins.length > 0 &&
			[...otherRequests.values()].every((other) =>
				isErasureRequestOlder(ownRequest, other),
			)
		if (!oldestLeaving) blocking.push(membership)
	}
	return blocking
}

/** SQL condition: the user in `userIdColumn` has an erasure request pending. */
export function hasPendingErasure(userIdColumn: Parameters<typeof eq>[0]) {
	return exists(
		db
			.select({ id: DataSubjectRequest.id })
			.from(DataSubjectRequest)
			.where(
				and(
					eq(DataSubjectRequest.userId, userIdColumn),
					eq(DataSubjectRequest.type, 'erasure'),
					inArray(DataSubjectRequest.status, ACTIVE_ERASURE_STATUSES),
				),
			),
	)
}

export async function createExportRequest(
	userId: string,
	request?: Request,
): Promise<GdprRequestResult> {
	const existingRequest = await getActiveRequest(userId, 'export')
	if (existingRequest) {
		return {
			success: false,
			error: 'An export request is already in progress',
			requestId: existingRequest.id,
		}
	}

	const ipAddress = request
		? getClientIp(request, { returnUndefined: true })
		: undefined
	const userAgent = request?.headers.get('user-agent') || undefined

	const [dsr] = await db
		.insert(DataSubjectRequest)
		.values({
			userId,
			type: 'export',
			status: 'processing',
			processedAt: new Date(),
			ipAddress,
			userAgent,
		})
		.returning({ id: DataSubjectRequest.id })
	if (!dsr) throw new Error('Failed to create export request')

	await auditService.log({
		action: AuditAction.DATA_EXPORT_REQUESTED,
		userId,
		details: 'User requested data export (GDPR Article 20)',
		resourceType: 'data_subject_request',
		resourceId: dsr.id,
		request,
		severity: 'info',
	})

	return {
		success: true,
		requestId: dsr.id,
	}
}

export async function generateUserDataExport(
	userId: string,
	requestId: string,
	request: Request,
): Promise<UserDataExport> {
	// Import and use the shared data gathering function
	const { gatherUserDataForExport } = await import('@repo/common/gdpr-export')
	const exportData = await gatherUserDataForExport(userId, request)

	await db
		.update(DataSubjectRequest)
		.set({
			status: 'completed',
			completedAt: new Date(),
			metadata: JSON.stringify({
				statistics: exportData.statistics,
				schemaVersion: exportData.schemaVersion,
			}),
		})
		.where(eq(DataSubjectRequest.id, requestId))

	await auditService.log({
		action: AuditAction.DATA_EXPORT_COMPLETED,
		userId,
		details: 'Data export completed successfully',
		resourceType: 'data_subject_request',
		resourceId: requestId,
		request,
		metadata: {
			statistics: exportData.statistics,
		},
		severity: 'info',
	})

	return exportData
}

export async function createErasureRequest(
	userId: string,
	request?: Request,
): Promise<GdprRequestResult> {
	const existingRequest = await getActiveRequest(userId, 'erasure')
	if (existingRequest) {
		return {
			success: false,
			error: 'A deletion request is already pending',
			requestId: existingRequest.id,
			scheduledFor: existingRequest.scheduledFor || undefined,
		}
	}

	const blockingOrgs = await findSoleAdminOrganizations(userId)

	if (blockingOrgs.length > 0) {
		const orgNames = blockingOrgs.map((org) => org.name).join(', ')
		return {
			success: false,
			error: `You are the sole admin of the following organizations: ${orgNames}. Please assign another admin before requesting account deletion.`,
		}
	}

	const scheduledFor = new Date()
	scheduledFor.setDate(scheduledFor.getDate() + GDPR_DELETION_GRACE_PERIOD_DAYS)

	const ipAddress = request
		? getClientIp(request, { returnUndefined: true })
		: undefined
	const userAgent = request?.headers.get('user-agent') || undefined

	const [dsr] = await db
		.insert(DataSubjectRequest)
		.values({
			userId,
			type: 'erasure',
			status: 'scheduled',
			scheduledFor,
			ipAddress,
			userAgent,
		})
		.returning({ id: DataSubjectRequest.id })
	if (!dsr) throw new Error('Failed to create erasure request')

	await db.delete(Session).where(eq(Session.userId, userId))

	await db
		.update(RefreshToken)
		.set({ revoked: true })
		.where(eq(RefreshToken.userId, userId))

	await auditService.log({
		action: AuditAction.DATA_DELETION_REQUESTED,
		userId,
		details: `User requested account deletion (GDPR Article 17). Scheduled for ${scheduledFor.toISOString()}`,
		resourceType: 'data_subject_request',
		resourceId: dsr.id,
		request,
		metadata: {
			scheduledFor: scheduledFor.toISOString(),
			gracePeriodDays: GDPR_DELETION_GRACE_PERIOD_DAYS,
		},
		severity: 'warning',
	})

	return {
		success: true,
		requestId: dsr.id,
		scheduledFor,
	}
}

export async function cancelErasureRequest(
	userId: string,
	request?: Request,
): Promise<GdprRequestResult> {
	const [activeRequest] = await db
		.select()
		.from(DataSubjectRequest)
		.where(
			and(
				eq(DataSubjectRequest.userId, userId),
				eq(DataSubjectRequest.type, 'erasure'),
				eq(DataSubjectRequest.status, 'scheduled'),
				gt(DataSubjectRequest.scheduledFor, new Date()),
			),
		)
		.limit(1)

	if (!activeRequest) {
		return {
			success: false,
			error: 'No active deletion request found to cancel',
		}
	}

	await db
		.update(DataSubjectRequest)
		.set({
			status: 'cancelled',
			cancelledAt: new Date(),
		})
		.where(eq(DataSubjectRequest.id, activeRequest.id))

	await auditService.log({
		action: AuditAction.DATA_DELETION_CANCELLED,
		userId,
		details: 'User cancelled account deletion request',
		resourceType: 'data_subject_request',
		resourceId: activeRequest.id,
		request,
		severity: 'info',
	})

	return {
		success: true,
		requestId: activeRequest.id,
	}
}

export async function getActiveErasureRequest(userId: string): Promise<{
	id: string
	status: string
	scheduledFor: Date | null
	requestedAt: Date
} | null> {
	const [request] = await db
		.select({
			id: DataSubjectRequest.id,
			status: DataSubjectRequest.status,
			scheduledFor: DataSubjectRequest.scheduledFor,
			requestedAt: DataSubjectRequest.requestedAt,
		})
		.from(DataSubjectRequest)
		.where(
			and(
				eq(DataSubjectRequest.userId, userId),
				eq(DataSubjectRequest.type, 'erasure'),
				inArray(DataSubjectRequest.status, [
					'requested',
					'processing',
					'scheduled',
				]),
			),
		)
		.limit(1)
	return request ?? null
}

export async function getLatestExportRequest(userId: string): Promise<{
	id: string
	status: string
	completedAt: Date | null
	requestedAt: Date
} | null> {
	const [request] = await db
		.select({
			id: DataSubjectRequest.id,
			status: DataSubjectRequest.status,
			completedAt: DataSubjectRequest.completedAt,
			requestedAt: DataSubjectRequest.requestedAt,
		})
		.from(DataSubjectRequest)
		.where(
			and(
				eq(DataSubjectRequest.userId, userId),
				eq(DataSubjectRequest.type, 'export'),
			),
		)
		.orderBy(desc(DataSubjectRequest.requestedAt))
		.limit(1)
	return request ?? null
}

/** A claimed erasure still `processing` after this long crashed; it is retried. */
export const ERASURE_STALE_PROCESSING_MS = 30 * 60 * 1000
/** Wait before retrying a failed erasure. */
export const ERASURE_RETRY_DELAY_MS = 15 * 60 * 1000
/** Attempts (including the first) before a failed erasure is left for a person. */
export const ERASURE_MAX_ATTEMPTS = 5
/** How long an erasure blocked by the sole-admin rule waits before it is checked again. */
export const ERASURE_SOLE_ADMIN_HOLD_MS = 24 * 60 * 60 * 1000

/**
 * Bookkeeping kept on the request itself. `userId` and `staffErasureOrgIds` are
 * written before the account is deleted (deleting it nulls the request's
 * `userId`), so a run that crashes after the delete can still queue the
 * regional staff erasures on retry. Ids only.
 */
type ErasureMetadata = {
	attempts?: number
	userId?: string
	staffErasureOrgIds?: string[]
}

function readErasureMetadata(raw: string | null): ErasureMetadata {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== 'object') return {}
		const value = parsed as Record<string, unknown>
		return {
			attempts:
				typeof value.attempts === 'number' && value.attempts >= 0
					? value.attempts
					: undefined,
			userId: typeof value.userId === 'string' ? value.userId : undefined,
			staffErasureOrgIds: Array.isArray(value.staffErasureOrgIds)
				? value.staffErasureOrgIds.filter(
						(id): id is string => typeof id === 'string',
					)
				: undefined,
		}
	} catch {
		return {}
	}
}

type DueErasure = typeof DataSubjectRequest.$inferSelect

type ErasureOutcome =
	| { result: 'completed' }
	| { result: 'held'; reason: string }
	| { result: 'skipped' }

async function executeErasureRequest(
	dsr: DueErasure,
	now: Date,
): Promise<ErasureOutcome> {
	const previous = readErasureMetadata(dsr.metadata)
	const attempts = (previous.attempts ?? 0) + 1

	// Claim the row with a compare-and-set on the state it was read in, so two
	// overlapping runs (cron and an admin expedite) never both execute it.
	const [claimed] = await db
		.update(DataSubjectRequest)
		.set({
			status: 'processing',
			processedAt: now,
			metadata: JSON.stringify({ ...previous, attempts }),
		})
		.where(
			and(
				eq(DataSubjectRequest.id, dsr.id),
				eq(DataSubjectRequest.status, dsr.status),
				dsr.processedAt
					? eq(DataSubjectRequest.processedAt, dsr.processedAt)
					: isNull(DataSubjectRequest.processedAt),
			),
		)
		.returning({ id: DataSubjectRequest.id })
	if (!claimed) return { result: 'skipped' }

	let metadata: ErasureMetadata = { ...previous, attempts }

	if (dsr.userId) {
		// The sole-admin rule is checked again now: other admins may have left or
		// requested their own erasure since this request was made.
		const blocking = await findSoleAdminOrganizations(dsr.userId)
		if (blocking.length > 0) {
			const reason = `sole_admin: ${blocking.map((org) => org.organizationId).join(',')}`
			await db
				.update(DataSubjectRequest)
				.set({
					status: 'scheduled',
					scheduledFor: new Date(now.getTime() + ERASURE_SOLE_ADMIN_HOLD_MS),
					failureReason: reason,
					// A hold is not a failed attempt.
					metadata: JSON.stringify({ ...previous }),
				})
				.where(eq(DataSubjectRequest.id, dsr.id))
			return { result: 'held', reason }
		}

		metadata = {
			...metadata,
			userId: dsr.userId,
			staffErasureOrgIds: await staffErasureOrganizationIds(dsr.userId),
		}
		await db
			.update(DataSubjectRequest)
			.set({ metadata: JSON.stringify(metadata) })
			.where(eq(DataSubjectRequest.id, dsr.id))

		// The account's invite links go with it (ON DELETE CASCADE); website
		// pages it created stay with the organization, author cleared (SET NULL).
		await db.delete(User).where(eq(User.id, dsr.userId))
	}

	// Only after the account is gone: a delete that fails must not leave the
	// staff record anonymized for an account that still exists.
	const erasedUserId = dsr.userId ?? metadata.userId
	if (erasedUserId && metadata.staffErasureOrgIds?.length) {
		const queued = await enqueueStaffErasureForOrganizations(
			erasedUserId,
			metadata.staffErasureOrgIds,
		)
		await flushStaffErasure(erasedUserId, queued)
	}

	await db
		.update(DataSubjectRequest)
		.set({
			status: 'completed',
			completedAt: new Date(),
			executedAt: new Date(),
			failureReason: null,
		})
		.where(eq(DataSubjectRequest.id, dsr.id))
	return { result: 'completed' }
}

/**
 * Runs every erasure that is due: scheduled ones whose grace period is over,
 * ones left `processing` by a run that crashed, and failed ones that have
 * attempts left. Shared by the cron route and Admin's expedite (which passes
 * `requestId`).
 */
export async function processDueErasureRequests(
	options: { now?: Date; requestId?: string } = {},
): Promise<{
	processed: number
	failed: number
	held: number
	errors: Array<{ requestId: string; error: string }>
}> {
	const now = options.now ?? new Date()
	const candidates = await db
		.select()
		.from(DataSubjectRequest)
		.where(
			and(
				eq(DataSubjectRequest.type, 'erasure'),
				options.requestId
					? eq(DataSubjectRequest.id, options.requestId)
					: undefined,
				or(
					and(
						eq(DataSubjectRequest.status, 'scheduled'),
						lte(DataSubjectRequest.scheduledFor, now),
					),
					and(
						eq(DataSubjectRequest.status, 'processing'),
						lte(
							DataSubjectRequest.processedAt,
							new Date(now.getTime() - ERASURE_STALE_PROCESSING_MS),
						),
					),
					and(
						eq(DataSubjectRequest.status, 'failed'),
						or(
							isNull(DataSubjectRequest.processedAt),
							lte(
								DataSubjectRequest.processedAt,
								new Date(now.getTime() - ERASURE_RETRY_DELAY_MS),
							),
						),
					),
				),
			),
		)
	const dueRequests = candidates.filter(
		(dsr) =>
			dsr.status !== 'failed' ||
			(readErasureMetadata(dsr.metadata).attempts ?? 0) < ERASURE_MAX_ATTEMPTS,
	)

	const results = {
		processed: 0,
		failed: 0,
		held: 0,
		errors: [] as Array<{ requestId: string; error: string }>,
	}

	for (const dsr of dueRequests) {
		const subjectUserId =
			dsr.userId ?? readErasureMetadata(dsr.metadata).userId ?? null
		try {
			const outcome = await executeErasureRequest(dsr, now)
			if (outcome.result === 'skipped') continue
			if (outcome.result === 'held') {
				await auditService.log({
					action: AuditAction.DATA_DELETION_FAILED,
					details:
						'Account deletion postponed: the user is the only admin of an organization',
					resourceType: 'data_subject_request',
					resourceId: dsr.id,
					metadata: { userId: subjectUserId, reason: outcome.reason },
					severity: 'warning',
				})
				results.held++
				continue
			}

			await auditService.log({
				action: AuditAction.DATA_DELETION_COMPLETED,
				details: `User account deleted (GDPR Article 17). User ID: ${subjectUserId}`,
				resourceType: 'data_subject_request',
				resourceId: dsr.id,
				metadata: {
					userId: subjectUserId,
					requestedAt: dsr.requestedAt.toISOString(),
					scheduledFor: dsr.scheduledFor?.toISOString(),
				},
				severity: 'warning',
			})

			results.processed++
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'

			await db
				.update(DataSubjectRequest)
				.set({
					status: 'failed',
					failureReason: errorMessage.slice(0, 500),
				})
				.where(
					and(
						eq(DataSubjectRequest.id, dsr.id),
						eq(DataSubjectRequest.status, 'processing'),
					),
				)

			await auditService.log({
				action: AuditAction.DATA_DELETION_FAILED,
				details: `Failed to delete user account: ${errorMessage}`,
				resourceType: 'data_subject_request',
				resourceId: dsr.id,
				metadata: {
					userId: subjectUserId,
					error: errorMessage,
				},
				severity: 'error',
			})

			results.failed++
			results.errors.push({ requestId: dsr.id, error: errorMessage })
		}
	}

	return results
}
