import { type LoyaltyLabels } from '~/lib/loyalty/labels'

/** Must match the id `LoyaltyLabels.astro` renders. */
export const LOYALTY_LABELS_ELEMENT_ID = 'loyalty-labels'

/** The translated strings the page rendered with `LoyaltyLabels.astro`. */
export function readLoyaltyLabels(doc: Document = document): LoyaltyLabels {
	const node = doc.getElementById(LOYALTY_LABELS_ELEMENT_ID)
	try {
		return JSON.parse(node?.textContent || '{}') as LoyaltyLabels
	} catch {
		return {} as LoyaltyLabels
	}
}
