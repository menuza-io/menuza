import { type AttentionItem } from '@repo/inventory'
import { inventoryCountPath, inventoryCountReviewPath } from './nav.ts'

/**
 * Where each "needs attention" row leads. One sentence, one action: the
 * region decides which rows exist (by rules, never prose); the App decides
 * where a row's single link goes.
 */

export type AttentionTarget = {
	kind: AttentionItem['kind']
	to: string
}

function join(path: string, search: string, extra?: Record<string, string>) {
	const params = new URLSearchParams(
		search.startsWith('?') ? search.slice(1) : search,
	)
	for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value)
	const query = params.toString()
	return query === '' ? path : `${path}?${query}`
}

export function attentionTarget(
	item: AttentionItem,
	{
		orgSlug,
		search,
		canEdit,
	}: {
		orgSlug: string
		/** The query string to keep on links (`?locationId=…`), with its `?`. */
		search: string
		canEdit: boolean
	},
): AttentionTarget {
	const base = `/${orgSlug}/inventory`
	switch (item.kind) {
		case 'low_stock':
			return {
				kind: item.kind,
				to: join(`${base}/stock`, search, { low: '1' }),
			}
		case 'count_due':
			return {
				kind: item.kind,
				to: join(
					`${base}/counts`,
					search,
					canEdit ? { start: '1' } : undefined,
				),
			}
		case 'count_in_progress':
			return {
				kind: item.kind,
				to: join(inventoryCountPath(orgSlug, item.countId), search),
			}
		case 'count_in_review':
			return {
				kind: item.kind,
				to: join(inventoryCountReviewPath(orgSlug, item.countId), search),
			}
		case 'price_rise':
			return {
				kind: item.kind,
				to: join(
					`${base}/purchasing/deliveries/${encodeURIComponent(item.deliveryId)}`,
					search,
				),
			}
		case 'unpaid_deliveries':
			return { kind: item.kind, to: join(`${base}/purchasing`, search) }
	}
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days between a past moment and now (0 for today), never negative. */
export function daysSince(at: number, now: number): number {
	return Math.max(0, Math.floor((now - at) / DAY_MS))
}

/** A basis-point change as a whole percent: 1400 → 14. */
export function percentFromBp(bp: number): number {
	return Math.round(bp / 100)
}

/** `YYYY-MM-DD` as a local calendar date (never shifted by the time zone). */
export function localDate(iso: string): Date {
	const [year, month, day] = iso.split('-').map(Number) as [
		number,
		number,
		number,
	]
	return new Date(year, month - 1, day)
}
