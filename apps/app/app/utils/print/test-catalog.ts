import {
	createPrintCatalog,
	type PrintCatalogExtension,
} from '@repo/common/print-shop'
import { z } from 'zod'

/**
 * A made-up vertical for unit tests: a card set with one card per desk and a
 * folded tent, so the core's per-piece and folding paths are tested without
 * any real vertical. Tests mock `@repo/common/print-shop-catalog` with it.
 */
export const testPrintCatalogExtension: PrintCatalogExtension = {
	products: [
		{
			key: 'desk_card',
			family: 'card',
			shippable: true,
			featuredItems: false,
			qrTargets: ['desk', 'site'],
			sizes: [
				{ key: 'a6', widthMm: 105, heightMm: 148, label: 'A6 · 105 × 148 mm' },
				{ key: '4x6', widthMm: 102, heightMm: 152, label: '4 × 6 in' },
			],
		},
		{
			key: 'desk_tent',
			family: 'card',
			shippable: false,
			folded: true,
			featuredItems: false,
			qrTargets: ['desk', 'site'],
			sizes: [{ key: '4x6', widthMm: 102, heightMm: 152, label: '4 × 6 in' }],
		},
	],
	qrTargets: [
		{
			kind: 'desk',
			perPiece: true,
			schema: z.strictObject({
				kind: z.literal('desk'),
				deskIds: z.array(z.string()).min(1),
			}),
			copy: () => ({
				headline: 'Scan to check in',
				callToAction: 'Check in from your phone',
				qrCaption: 'Scan to check in',
			}),
			pieceWord: (locale) => (locale.startsWith('ar') ? 'مكتب' : 'Desk'),
		},
	],
}

export const testPrintCatalog = createPrintCatalog(testPrintCatalogExtension)
