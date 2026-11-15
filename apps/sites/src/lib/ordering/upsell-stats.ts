/**
 * An anonymous count of what the "Goes well with" row did (#114): per dish
 * id, how often it was shown and how often it was added. No customer id, no
 * order id, nothing that identifies a person. It is kept in this browser
 * (`localStorage`, per restaurant) and announced as a `menuza:upsell` event
 * on the document, which is where a later report can collect it; nothing is
 * sent anywhere from here.
 */
export type UpsellCounts = Record<string, { shown: number; added: number }>

export const UPSELL_EVENT = 'menuza:upsell'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

const key = (orgId: string) => `menuza_upsell_${orgId}`

export function readUpsellCounts(
	orgId: string,
	storage: StorageLike | null = defaultStorage(),
): UpsellCounts {
	try {
		const raw = storage?.getItem(key(orgId))
		if (!raw) return {}
		const parsed: unknown = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object') return {}
		const counts: UpsellCounts = {}
		for (const [id, value] of Object.entries(parsed)) {
			const entry = value as { shown?: unknown; added?: unknown }
			const shown = Number(entry?.shown)
			const added = Number(entry?.added)
			counts[id] = {
				shown: Number.isFinite(shown) && shown > 0 ? Math.floor(shown) : 0,
				added: Number.isFinite(added) && added > 0 ? Math.floor(added) : 0,
			}
		}
		return counts
	} catch {
		return {}
	}
}

function defaultStorage(): StorageLike | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage
	} catch {
		return null
	}
}

/** Counts one dish being shown or added, and announces it. */
export function recordUpsell(
	orgId: string,
	itemId: string,
	action: 'shown' | 'added',
	storage: StorageLike | null = defaultStorage(),
	target: Pick<EventTarget, 'dispatchEvent'> | null = typeof document ===
	'undefined'
		? null
		: document,
): void {
	const counts = readUpsellCounts(orgId, storage)
	const entry = counts[itemId] ?? { shown: 0, added: 0 }
	entry[action] += 1
	counts[itemId] = entry
	try {
		storage?.setItem(key(orgId), JSON.stringify(counts))
	} catch {
		// Quota or privacy mode: the event below still goes out.
	}
	try {
		target?.dispatchEvent(
			new CustomEvent(UPSELL_EVENT, { detail: { itemId, action } }),
		)
	} catch {
		// Not a browser.
	}
}

/**
 * Counts a dish as shown once per page view, however often the row repaints.
 */
export function createShownCounter(
	record: (itemId: string) => void,
): (itemIds: readonly string[]) => void {
	const seen = new Set<string>()
	return (itemIds) => {
		for (const id of itemIds) {
			if (seen.has(id)) continue
			seen.add(id)
			record(id)
		}
	}
}
