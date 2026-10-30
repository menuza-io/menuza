import { requireUserWithRole } from '@repo/auth'
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
import { type Route } from './+types/run.ts'

export async function action({ request }: Route.ActionArgs) {
	await requireUserWithRole(request, 'admin')
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

	const catalog = getCatalog('platform')
	const subject = getSubject(catalog, parsed.data.subject)
	if (!subject || subject.source !== 'control-plane') {
		return data(
			{ error: 'unknown_subject' as const, message: 'Unknown report subject.' },
			{ status: 400 },
		)
	}

	const records = await fetchControlPlaneRecords({
		subject: parsed.data.subject,
		scope: 'platform',
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
