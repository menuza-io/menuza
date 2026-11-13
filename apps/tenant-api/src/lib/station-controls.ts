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
	| { ok: false; code: 'controls_unavailable' | 'location_not_found' }

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
			void response.body?.cancel().catch(() => undefined)
			return {
				ok: false,
				code:
					response.status === 404
						? 'location_not_found'
						: 'controls_unavailable',
			}
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
