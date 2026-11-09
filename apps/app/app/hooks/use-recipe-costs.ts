import {
	MAX_RECIPE_COST_REFS,
	type RecipeCostsRequest,
	recipeCostsResultSchema,
} from '@repo/inventory'
import { useEffect, useMemo, useState } from 'react'
import { type z } from 'zod'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { isRecipesUnavailable } from '#app/utils/inventory/inventory-errors.ts'
import { chunk } from '#app/utils/inventory/recipe-form.ts'

type CostRow = z.infer<typeof recipeCostsResultSchema>['rows'][number]
export type RecipeCostRef = RecipeCostsRequest['refs'][number]

export type RecipeCosts = {
	/** Rows by the caller's `key`; null until the first answer. */
	rows: ReadonlyMap<string, CostRow> | null
	targetBp: number | null
	loading: boolean
	failed: boolean
	/** The region says recipes are not available to this member. */
	unavailable: boolean
	reload: () => void
}

/**
 * The cost of many dishes from `POST /recipes/costs`, joined by `key`. The
 * browser sends ids and the prices it shows, never names. A page of up to 200
 * dishes is ONE call; more are split into 200s. The call only reads, so it
 * uses the read token.
 */
export function useRecipeCosts(
	refs: readonly RecipeCostRef[],
	currency: string,
	enabled = true,
	/** Change it to ask again (a recipe was saved somewhere on the page). */
	refreshKey = 0,
): RecipeCosts {
	const { request } = useInventoryClient()
	const [state, setState] = useState<Omit<RecipeCosts, 'reload'>>({
		rows: null,
		targetBp: null,
		loading: enabled && refs.length > 0,
		failed: false,
		unavailable: false,
	})
	const [tick, setTick] = useState(0)
	const signature = useMemo(() => JSON.stringify(refs), [refs])

	useEffect(() => {
		if (!enabled || refs.length === 0) return
		let live = true
		setState((current) => ({ ...current, loading: true, failed: false }))
		const priced = refs.some((ref) => ref.priceMinor !== undefined)
		void Promise.all(
			chunk(refs, MAX_RECIPE_COST_REFS).map(async (part) => {
				const body: RecipeCostsRequest = {
					refs: part,
					...(priced ? { currency } : {}),
				}
				return recipeCostsResultSchema.parse(
					await request('/recipes/costs', {
						method: 'POST',
						body: JSON.stringify(body),
						readOnly: true,
					}),
				)
			}),
		).then(
			(results) => {
				if (!live) return
				const rows = new Map<string, CostRow>()
				for (const result of results) {
					for (const row of result.rows) rows.set(row.key, row)
				}
				setState({
					rows,
					targetBp: results[0]?.targetBp ?? null,
					loading: false,
					failed: false,
					unavailable: false,
				})
			},
			(error: unknown) => {
				if (!live) return
				setState((current) => ({
					...current,
					loading: false,
					failed: true,
					unavailable: isRecipesUnavailable(error),
				}))
			},
		)
		return () => {
			live = false
		}
		// `signature` stands for `refs`.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, signature, currency, request, tick, refreshKey])

	return { ...state, reload: () => setTick((value) => value + 1) }
}
