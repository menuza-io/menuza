import { requireUserId } from '@repo/auth'
import {
	getCatalog,
	getSubject,
	isReportRunError,
	reportDefinitionSchema,
	reportTimeZoneForRequest,
	runReport,
} from '@repo/reports'
import { fetchControlPlaneRecords } from '@repo/reports/server'
import { data } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { type Route } from './+types/run.ts'

export async function action({ request, params }: Route.ActionArgs) {
	await requireUserId(request)
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

	const records = await fetchControlPlaneRecords({
		subject: parsed.data.subject,
		scope: 'organization',
		organizationId: organization.id,
	})
	const result = runReport(catalog, parsed.data, records, new Date(), {
		timeZone: reportTimeZoneForRequest(parsed.data, body),
	})
	if (isReportRunError(result)) {
		return data(result, {
			status: result.error === 'missing_group_by' ? 422 : 400,
		})
	}
	return data(result)
}
