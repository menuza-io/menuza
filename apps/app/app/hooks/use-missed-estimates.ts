import { useEffect, useState } from 'react'
import { z } from 'zod'
import {
	type EntryEstimate,
	type MissedEstimateAnswer,
	missedEstimateAnswerSchema,
	type MissedPlanEntry,
	missedPlanEntrySchema,
	summarizeEntry,
} from '#app/utils/location/missed-estimate.ts'

export type MissedEstimates = {
	loading: boolean
	entries: MissedPlanEntry[]
	/** By `entry.id`. An entry with no answer yet (or a refused one) has none. */
	estimates: ReadonlyMap<string, EntryEstimate>
}

const EMPTY: MissedEstimates = {
	loading: false,
	entries: [],
	estimates: new Map(),
}

/**
 * The estimate of sales missed while online ordering was paused (#176),
 * loaded in the browser: the App says which windows to estimate (times only),
 * the region adds up what it holds and returns totals. Both calls are best
 * effort: a member without the report grant, or a region that cannot be
 * reached, simply gets no estimate (never a made-up one).
 */
export function useMissedEstimates(options: {
	orgSlug: string
	tokenUrl: string
	tenantApiUrl: string | null
	mode: 'latest' | 'today'
	enabled?: boolean
}): MissedEstimates {
	const { orgSlug, tokenUrl, tenantApiUrl, mode, enabled = true } = options
	const [state, setState] = useState<MissedEstimates>(EMPTY)

	useEffect(() => {
		if (!enabled || !tenantApiUrl) return
		const controller = new AbortController()
		const signal = controller.signal
		setState((current) => ({ ...current, loading: true }))
		void (async () => {
			try {
				const planResponse = await fetch(
					`/${orgSlug}/missed-sales-plan?mode=${mode}`,
					{ signal },
				)
				if (!planResponse.ok) return setState(EMPTY)
				const { entries } = z
					.object({ entries: z.array(missedPlanEntrySchema) })
					.parse(await planResponse.json())
				if (entries.length === 0) return setState(EMPTY)
				const tokenResponse = await fetch(tokenUrl, { signal })
				const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as {
					token?: unknown
				}
				if (!tokenResponse.ok || typeof tokenPayload.token !== 'string') {
					return setState(EMPTY)
				}
				const byLocation = new Map<string, MissedPlanEntry[]>()
				for (const entry of entries) {
					byLocation.set(entry.locationId, [
						...(byLocation.get(entry.locationId) ?? []),
						entry,
					])
				}
				const estimates = new Map<string, EntryEstimate>()
				await Promise.all(
					[...byLocation.entries()].map(async ([locationId, group]) => {
						const windows = group.flatMap((entry) =>
							entry.plans.map((plan, index) => ({
								id: `${entry.id}|${index}`,
								from: plan.from,
								to: plan.to,
								weeks: plan.weeks,
							})),
						)
						const response = await fetch(
							`${tenantApiUrl}/analytics/missed-estimate`,
							{
								method: 'POST',
								headers: {
									Authorization: `Bearer ${tokenPayload.token as string}`,
									'Content-Type': 'application/json',
								},
								body: JSON.stringify({
									locationId,
									currency: group[0]!.currency,
									windows: windows.slice(0, 50),
								}),
								signal,
							},
						)
						if (!response.ok) return
						const answers = missedEstimateAnswerSchema.parse(
							await response.json(),
						).estimates
						for (const entry of group) {
							const mine: MissedEstimateAnswer[] = answers.filter((answer) =>
								answer.id.startsWith(`${entry.id}|`),
							)
							if (mine.length === entry.plans.length) {
								estimates.set(entry.id, summarizeEntry(mine))
							}
						}
					}),
				)
				if (!signal.aborted) setState({ loading: false, entries, estimates })
			} catch {
				if (!signal.aborted) setState(EMPTY)
			}
		})()
		return () => controller.abort()
	}, [enabled, mode, orgSlug, tenantApiUrl, tokenUrl])

	return state
}
