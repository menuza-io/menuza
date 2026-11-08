import { auditService, AuditAction } from '@repo/audit'
import { requireUserId } from '@repo/auth'
import {
	createExportRequest,
	generateUserDataExport,
	markExportRequestFailed,
} from '#app/utils/gdpr.server.ts'
import { refuseWhileImpersonating } from '#app/utils/impersonation-guard.server.ts'
import { collectStaffExportsForUser } from '#app/utils/staffing/dsar.server.ts'
import { type Route } from './+types/download-user-data.ts'

export async function loader({ request }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	// The export is the user's full record, logged as their own request.
	await refuseWhileImpersonating(
		request,
		"Stop impersonating before downloading the user's data",
	)

	const result = await createExportRequest(userId, request)

	if (!result.success || !result.requestId) {
		await auditService.log({
			action: AuditAction.DATA_EXPORT_FAILED,
			userId,
			details: result.error || 'Failed to create export request',
			request,
			severity: 'error',
		})

		return Response.json(
			{ error: result.error || 'Failed to create export request' },
			{ status: 400 },
		)
	}

	try {
		const exportData = await generateUserDataExport(
			userId,
			result.requestId,
			request,
		)

		const timestamp = new Date().toISOString().split('T')[0]
		const filename = `user-data-export-${timestamp}.json`

		// Staff records live in the regional database. A US-region record is
		// generated there and attached; a Saudi-region one is delivered in-region
		// by the organization, so the file only points to it.
		const staffRecords = await collectStaffExportsForUser(userId)

		return new Response(
			JSON.stringify({ ...exportData, staffRecords }, null, 2),
			{
				headers: {
					'Content-Type': 'application/json',
					'Content-Disposition': `attachment; filename="${filename}"`,
					'Cache-Control': 'no-store, no-cache, must-revalidate',
				},
			},
		)
	} catch (error) {
		// A failed export must not stay `processing`: that would block the
		// user's next export.
		await markExportRequestFailed(
			result.requestId,
			error instanceof Error ? error.message : 'Failed to generate export',
		).catch(() => {})
		await auditService.log({
			action: AuditAction.DATA_EXPORT_FAILED,
			userId,
			details:
				error instanceof Error ? error.message : 'Failed to generate export',
			request,
			severity: 'error',
			metadata: {
				requestId: result.requestId,
			},
		})

		throw error
	}
}
