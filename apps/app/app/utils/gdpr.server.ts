import { auditService, AuditAction } from '@repo/audit'
import {
	and,
	count,
	db,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	DataSubjectRequest,
	Organization,
	OrganizationRole,
	RefreshToken,
	Session,
	User,
	UserOrganization,
} from '@repo/database'
import { getClientIp } from '@repo/security'

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

async function getActiveRequest(
	userId: string,
	type: DataSubjectRequestType,
): Promise<{ id: string; status: string; scheduledFor: Date | null } | null> {
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
				eq(OrganizationRole.name, 'admin'),
				isNull(OrganizationRole.organizationId),
			),
		)
	const blockingOrgs = []
	for (const membership of adminMemberships) {
		const [adminCount] = await db
			.select({ value: count() })
			.from(UserOrganization)
			.innerJoin(
				OrganizationRole,
				eq(UserOrganization.organizationRoleId, OrganizationRole.id),
			)
			.where(
				and(
					eq(UserOrganization.organizationId, membership.organizationId),
					eq(UserOrganization.active, true),
					eq(OrganizationRole.name, 'admin'),
					isNull(OrganizationRole.organizationId),
				),
			)
		if ((adminCount?.value ?? 0) === 1) blockingOrgs.push(membership)
	}

	if (blockingOrgs.length > 0) {
		const orgNames = blockingOrgs.map((uo) => uo.name).join(', ')
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

export async function processDueErasureRequests(): Promise<{
	processed: number
	failed: number
	errors: Array<{ requestId: string; error: string }>
}> {
	const now = new Date()
	const dueRequests = await db
		.select()
		.from(DataSubjectRequest)
		.where(
			and(
				eq(DataSubjectRequest.type, 'erasure'),
				eq(DataSubjectRequest.status, 'scheduled'),
				lte(DataSubjectRequest.scheduledFor, now),
			),
		)

	const results = {
		processed: 0,
		failed: 0,
		errors: [] as Array<{ requestId: string; error: string }>,
	}

	for (const dsr of dueRequests) {
		try {
			await db
				.update(DataSubjectRequest)
				.set({
					status: 'processing',
					processedAt: new Date(),
				})
				.where(eq(DataSubjectRequest.id, dsr.id))

			if (dsr.userId) await db.delete(User).where(eq(User.id, dsr.userId))

			await db
				.update(DataSubjectRequest)
				.set({
					status: 'completed',
					completedAt: new Date(),
					executedAt: new Date(),
				})
				.where(eq(DataSubjectRequest.id, dsr.id))

			await auditService.log({
				action: AuditAction.DATA_DELETION_COMPLETED,
				details: `User account deleted (GDPR Article 17). User ID: ${dsr.userId}`,
				resourceType: 'data_subject_request',
				resourceId: dsr.id,
				metadata: {
					userId: dsr.userId,
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
					failureReason: errorMessage,
				})
				.where(eq(DataSubjectRequest.id, dsr.id))

			await auditService.log({
				action: AuditAction.DATA_DELETION_FAILED,
				details: `Failed to delete user account: ${errorMessage}`,
				resourceType: 'data_subject_request',
				resourceId: dsr.id,
				metadata: {
					userId: dsr.userId,
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
