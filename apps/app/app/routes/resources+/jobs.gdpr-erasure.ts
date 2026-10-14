import { auditService, AuditAction } from '@repo/audit'
import { and, DataSubjectRequest, db, eq, lte, User } from '@repo/database'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	enqueueStaffErasureForUser,
	flushStaffErasure,
} from '#app/utils/staffing/dsar.server.ts'
import { type Route } from './+types/jobs.gdpr-erasure.ts'

export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	await requireInternalCommandAuth(request)

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

			let staffErasureOrgs: string[] = []
			if (dsr.userId) {
				// Queue the regional staff anonymization first: if it cannot be
				// recorded, the request fails and the account is not deleted.
				staffErasureOrgs = await enqueueStaffErasureForUser(dsr.userId)
				await db.delete(User).where(eq(User.id, dsr.userId))
				await flushStaffErasure(dsr.userId, staffErasureOrgs)
			}

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

	return Response.json({
		success: results.failed === 0,
		...results,
		timestamp: now.toISOString(),
	})
}
