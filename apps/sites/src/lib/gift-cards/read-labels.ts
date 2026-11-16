import { type GiftCardLabels } from '~/lib/gift-cards/labels'

/** Must match the id `GiftCardLabels.astro` renders. */
export const GIFT_CARD_LABELS_ELEMENT_ID = 'gift-card-labels'

/** The translated strings the page rendered with `GiftCardLabels.astro`. */
export function readGiftCardLabels(doc: Document = document): GiftCardLabels {
	const node = doc.getElementById(GIFT_CARD_LABELS_ELEMENT_ID)
	try {
		return JSON.parse(node?.textContent || '{}') as GiftCardLabels
	} catch {
		return {} as GiftCardLabels
	}
}

/** Fills `{name}` placeholders. */
export function fillGiftCardTemplate(
	template: string | undefined,
	values: Record<string, string>,
): string {
	return (template ?? '').replace(/\{(\w+)\}/g, (match, key: string) =>
		key in values ? values[key]! : match,
	)
}
