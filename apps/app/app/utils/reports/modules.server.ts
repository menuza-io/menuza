import { getFeatureFlag } from '@repo/common/feature-flags'
import { db, eq, PhoneAgent } from '@repo/database'
import { LOYALTY_FLAG_KEYS } from '@repo/loyalty'
import {
	FIGURES,
	figureValue,
	getCatalog,
	isReportRunError,
	runReport,
	type FigureId,
	type FigureModule,
	type FigureValue,
	type TimeframePreset,
} from '@repo/reports'
import { RESERVATIONS_FLAG_KEYS } from '@repo/reservations'
import { isFlagOn } from '@repo/staffing'
import { isStaffingFeatureEnabled } from '#app/utils/staffing/access.server.ts'
import { loadCachedReviewRecords } from './review-records.server.ts'

/**
 * The modules a summary figure can need, as switched on for an organization
 * (#121, #221). A figure of a module that is off is left out of the daily
 * summary and shown as one quiet "Not switched on yet" line on the monthly
 * page; a figure whose module is on but whose grant the viewer lacks is hidden.
 */
export async function resolveFigureModules(
	organizationId: string,
): Promise<FigureModule[]> {
	const [labor, reservations, loyalty, agent] = await Promise.all([
		isStaffingFeatureEnabled(organizationId, 'labor'),
		getFeatureFlag(RESERVATIONS_FLAG_KEYS.enabled, { organizationId }),
		getFeatureFlag(LOYALTY_FLAG_KEYS.enabled, { organizationId }),
		db
			.select({ id: PhoneAgent.id })
			.from(PhoneAgent)
			.where(eq(PhoneAgent.organizationId, organizationId))
			.limit(1),
	])
	const modules: FigureModule[] = ['marketing']
	if (labor) modules.push('staffing_labor')
	if (isFlagOn(reservations)) modules.push('reservations')
	if (isFlagOn(loyalty)) modules.push('loyalty')
	if (agent.length > 0) modules.push('phone_agent')
	return modules
}

/**
 * Review figures come from the control plane's connected review sites (never
 * regional data), run by the same engine as the Reviews report. `asOf` is the
 * instant of the period and of the one it is compared with.
 */
export async function reviewFigureValue(input: {
	organizationId: string
	id: Extract<FigureId, 'newReviews' | 'averageRating'>
	preset: TimeframePreset
	asOf: { current: Date; previous: Date }
	timeZone: string
}): Promise<FigureValue> {
	const loaded = await loadCachedReviewRecords(input.organizationId)
	const catalog = getCatalog('organization')
	const definition = FIGURES[input.id].definition(input.preset)
	const run = (at: Date) => {
		const result = runReport(catalog, definition, loaded.records, at, {
			timeZone: input.timeZone,
		})
		return isReportRunError(result) ? null : result
	}
	return figureValue(
		input.id,
		run(input.asOf.current),
		run(input.asOf.previous),
	)
}
