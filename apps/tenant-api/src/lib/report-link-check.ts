import {
	REPORT_LINK_CHECK_PATH,
	reportLinkCheckResponseSchema,
	type ReportGrants,
	type ReportLinkCheckRequest,
} from '@repo/reports/send-contract'
import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Asks the US App whether a scheduled report's CSV link may still be served
 * and with which grants (`POST /resources/report-link-check`, internal
 * token; ids in, grants out). It fails closed: an App that cannot be reached
 * or does not answer in the agreed shape is `unavailable`, never "allowed".
 */
export type ReportLinkCheckOutcome =
	| { status: 'active'; grants: ReportGrants }
	| { status: 'revoked' }
	| { status: 'unavailable' }

function appUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

export async function checkReportLink(
	request: ReportLinkCheckRequest,
): Promise<ReportLinkCheckOutcome> {
	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) return { status: 'unavailable' }
	try {
		const response = await fetch(`${base}${REPORT_LINK_CHECK_PATH}`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(request),
			redirect: 'error',
			signal: AbortSignal.timeout(8_000),
		})
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined)
			return { status: 'unavailable' }
		}
		const answer = reportLinkCheckResponseSchema.safeParse(
			await response.json().catch(() => null),
		)
		if (!answer.success) return { status: 'unavailable' }
		return answer.data.active
			? { status: 'active', grants: answer.data.grants }
			: { status: 'revoked' }
	} catch {
		return { status: 'unavailable' }
	}
}
