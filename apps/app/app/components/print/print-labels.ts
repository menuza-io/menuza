import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type PrintTemplateStyle } from '@repo/common/print-shop'
import { printShopUi } from './vertical-ui.tsx'

const CORE_PRODUCT_LABELS: Record<
	string,
	{ name: MessageDescriptor; description: MessageDescriptor }
> = {
	poster: {
		name: msg`Poster`,
		description: msg`A large print for windows and walls.`,
	},
	flyer: {
		name: msg`Flyer`,
		description: msg`A handout for bags, counters and the neighborhood.`,
	},
	window_sticker: {
		name: msg`Window sticker`,
		description: msg`A square QR sign for the door or window. Print it yourself.`,
	},
}

/** A product's name and description: the vertical's words win. */
export function printProductLabel(key: string): {
	name: MessageDescriptor
	description: MessageDescriptor
} {
	return (
		printShopUi.products?.[key] ??
		CORE_PRODUCT_LABELS[key] ?? {
			name: msg`Print`,
			description: msg`A print of your design.`,
		}
	)
}

export const PRINT_STYLE_LABELS: Record<PrintTemplateStyle, MessageDescriptor> =
	{
		classic: msg`Classic`,
		bold: msg`Bold`,
		minimal: msg`Minimal`,
	}

const CORE_TARGET_LABELS: Record<string, MessageDescriptor> = {
	site: msg`A page on your website`,
	none: msg`No QR code`,
}

/**
 * A size as shown to operators: catalog labels are measurements (the same in
 * every language); a folded product adds a translated "(folded)".
 */
export function printSizeText(
	translate: (descriptor: MessageDescriptor) => string,
	label: string,
	folded: boolean | undefined,
): string {
	return folded ? `${label} ${translate(msg`(folded)`)}` : label
}

export function printTargetLabel(kind: string): MessageDescriptor {
	return (
		printShopUi.qrTargets?.[kind]?.label ??
		CORE_TARGET_LABELS[kind] ??
		msg`QR code`
	)
}
