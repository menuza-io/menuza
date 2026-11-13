import {
	STATION_CONTROLS_PATH,
	stationControlsRequestSchema,
	stationControlsResultSchema,
	type StationControlsRequest,
	type StationControlsResult,
} from '@repo/common/pos-station-controls'
import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Asks the US App to pause or resume online ordering, or to take a dish off
 * the menu (or back) at one location, for Station's manager controls
 * (`POST /resources/pos/station-controls`, internal token). Ids, a duration
 * and a boolean only: the schema is strict. Never queued: a failure is the
 * person's to retry while they watch.
 */
export type StationControlsOutcome =
	| { ok: true; result: StationControlsResult }
	| {
			ok: false
			/**
			 * `controls_misconfigured`: the App refused the request itself (contract
			 * skew, token mismatch, unknown organization): asking again cannot help.
			 */
			code:
				'controls_unavailable' | 'controls_misconfigured' | 'location_not_found'
	  }

function appUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

export async function postStationControls(
	request: StationControlsRequest,
): Promise<StationControlsOutcome> {
	const parsed = stationControlsRequestSchema.safeParse(request)
	if (!parsed.success) return { ok: false, code: 'controls_unavailable' }
	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) {
		return { ok: false, code: 'controls_unavailable' }
	}
	try {
		const response = await fetch(`${base}${STATION_CONTROLS_PATH}`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(parsed.data),
			redirect: 'error',
			signal: AbortSignal.timeout(8_000),
		})
		if (!response.ok) {
			const answer = (await response.json().catch(() => null)) as {
				error?: unknown
			} | null
			const error = typeof answer?.error === 'string' ? answer.error : null
			// Status and code only: the request carries no guest data, the answer none.
			console.warn('Station controls: App answered', response.status, error)
			if (response.status === 404 && error === 'location_not_found')
				return { ok: false, code: 'location_not_found' }
			if ([400, 401, 403, 404].includes(response.status))
				return { ok: false, code: 'controls_misconfigured' }
			return { ok: false, code: 'controls_unavailable' }
		}
		const answer = stationControlsResultSchema.safeParse(
			await response.json().catch(() => null),
		)
		if (!answer.success) return { ok: false, code: 'controls_unavailable' }
		return { ok: true, result: answer.data }
	} catch {
		return { ok: false, code: 'controls_unavailable' }
	}
}
