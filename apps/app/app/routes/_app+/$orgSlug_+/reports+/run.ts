import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import {
	getCatalog,
	getSubject,
	isReportRunError,
	type ReportRecord,
	reportDefinitionSchema,
	runReport,
} from '@repo/reports'
import { fetchControlPlaneRecords } from '@repo/reports/server'
import { data } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { loadCachedReviewRecords } from '#app/utils/reports/review-records.server.ts'
import { type Route } from './+types/run.ts'

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})

	const body = await request.json().catch(() => null)
	const parsed = reportDefinitionSchema.safeParse(
		body && typeof body === 'object' && 'definition' in body
			? body.definition
			: body,
	)
	if (!parsed.success) {
		return data(
			{
				error: 'invalid_definition' as const,
				message: parsed.error.errors[0]?.message || 'Invalid report definition',
			},
			{ status: 400 },
		)
	}

	const catalog = getCatalog('organization')
	const subject = getSubject(catalog, parsed.data.subject)
	if (!subject) {
		return data(
			{ error: 'unknown_subject' as const, message: 'Unknown report subject.' },
			{ status: 400 },
		)
	}
	if (subject.source === 'tenant-api') {
		return data(
			{
				error: 'invalid_definition' as const,
				message:
					'Customer analytics must be queried from the regional tenant API in the browser.',
			},
			{ status: 400 },
		)
	}

	let records: ReportRecord[]
	let sourceTruncated = false
	if (subject.id === 'reviews') {
		// Reviews come from the same connections as the mailbox reviews tab.
		const canReadReviews = await userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.READ_WEBSITE_ANY,
		)
		if (!canReadReviews) {
			return data(
				{
					error: 'unauthorized' as const,
					message: 'You need website access to report on reviews.',
				},
				{ status: 403 },
			)
		}
		const loaded = await loadCachedReviewRecords(organization.id)
		records = loaded.records
		sourceTruncated = loaded.truncated
	} else {
		records = await fetchControlPlaneRecords({
			subject: parsed.data.subject,
			scope: 'organization',
			organizationId: organization.id,
		})
	}

	const result = runReport(catalog, parsed.data, records)
	if (isReportRunError(result)) {
		return data(result, {
			status: result.error === 'missing_group_by' ? 422 : 400,
		})
	}
	return data(
		sourceTruncated
			? { ...result, sourceTruncated: true, sourceRowLimit: records.length }
			: result,
	)
}
