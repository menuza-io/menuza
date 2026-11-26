import { type CateringLabels } from '~/lib/catering/labels'

/** Must match the id `CateringLabels.astro` renders. */
export const CATERING_LABELS_ELEMENT_ID = 'catering-labels'

/** The translated strings the page rendered with `CateringLabels.astro`. */
export function readCateringLabels(doc: Document = document): CateringLabels {
	const node = doc.getElementById(CATERING_LABELS_ELEMENT_ID)
	try {
		return JSON.parse(node?.textContent || '{}') as CateringLabels
	} catch {
		return {} as CateringLabels
	}
}

/** Fills `{name}` placeholders. */
export function fillCateringTemplate(
	template: string | undefined,
	values: Record<string, string>,
): string {
	return (template ?? '').replace(/\{(\w+)\}/g, (match, key: string) =>
		key in values ? values[key]! : match,
	)
}
