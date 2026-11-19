import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import {
	getCatalog,
	getSubject,
	isReportRunError,
	type ReportRecord,
	reportDefinitionSchema,
	reportTimeZoneForRequest,
	runReport,
} from '@repo/reports'
import { fetchControlPlaneRecords } from '@repo/reports/server'
import {
	isGbpReportSubject,
	isPermissionGatedReportSubject,
} from '@repo/reports/token'
import { data } from 'react-router'
import { gbpFlags } from '#app/utils/gbp/context.server.ts'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import {
	loadGbpPerformanceRecords,
	loadGbpSearchKeywordRecords,
} from '#app/utils/reports/gbp-performance-records.server.ts'
import { loadCachedReviewRecords } from '#app/utils/reports/review-records.server.ts'
import { permissionGatedReportSubjects } from '#app/utils/staffing/report-grants.server.ts'
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
				message: parsed.error.issues[0]?.message || 'Invalid report definition',
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

	// Members and notes need the permission their app page needs.
	if (
		isPermissionGatedReportSubject(subject.id) &&
		!(await permissionGatedReportSubjects(userId, organization.id)).includes(
			subject.id,
		)
	) {
		return data(
			{
				error: 'forbidden' as const,
				message: 'You do not have access to this report subject.',
			},
			{ status: 403 },
		)
	}

	let records: ReportRecord[]
	let sourceTruncated = false
	let gbpMeta: { dataUntil: string | null; emptyNotice: string | null } | null =
		null
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
	} else if (isGbpReportSubject(subject.id)) {
		const [flags, canReadSettings] = await Promise.all([
			gbpFlags(organization.id),
			userHasOrganizationPermission(
				userId,
				organization.id,
				ORG_PERMISSIONS.READ_SETTINGS_ANY,
			),
		])
		if (!flags.insights || !canReadSettings) {
			return data(
				{
					error: 'forbidden' as const,
					message: 'You do not have access to Google listing performance.',
				},
				{ status: 403 },
			)
		}
		const scope = await resolveMemberLocationIds(userId, organization.id)
		if (subject.id === 'gbp_performance') {
			const loaded = await loadGbpPerformanceRecords(organization.id, scope)
			records = loaded.records
			gbpMeta = {
				dataUntil: loaded.dataUntil,
				emptyNotice: loaded.emptyNotice,
			}
		} else {
			const loaded = await loadGbpSearchKeywordRecords(organization.id, scope)
			records = loaded.records
		}
	} else {
		records = await fetchControlPlaneRecords({
			subject: parsed.data.subject,
			scope: 'organization',
			organizationId: organization.id,
			viewerUserId: userId,
		})
	}

	const result = runReport(catalog, parsed.data, records, new Date(), {
		timeZone: reportTimeZoneForRequest(parsed.data, body),
	})
	if (isReportRunError(result)) {
		return data(result, {
			status: result.error === 'missing_group_by' ? 422 : 400,
		})
	}
	return data({
		...result,
		...(sourceTruncated
			? { sourceTruncated: true, sourceRowLimit: records.length }
			: {}),
		...(gbpMeta ? gbpMeta : {}),
	})
}
