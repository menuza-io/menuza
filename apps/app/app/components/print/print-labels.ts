import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	type PrintProductKey,
	type PrintQrTarget,
	type PrintTemplateStyle,
} from '@repo/common/print-shop'

export const PRINT_PRODUCT_LABELS: Record<
	PrintProductKey,
	{ name: MessageDescriptor; description: MessageDescriptor }
> = {
	table_card: {
		name: msg`Table QR cards`,
		description: msg`One card per table, so guests order and pay from their phone.`,
	},
	poster: {
		name: msg`Poster`,
		description: msg`A large print for windows and walls, with featured dishes.`,
	},
	flyer: {
		name: msg`Flyer`,
		description: msg`A handout for bags, counters and the neighborhood.`,
	},
	table_tent: {
		name: msg`Table tent`,
		description: msg`A folded card that stands on the table. Print it yourself.`,
	},
	window_sticker: {
		name: msg`Window sticker`,
		description: msg`A square QR sign for the door or window. Print it yourself.`,
	},
}

export const PRINT_STYLE_LABELS: Record<PrintTemplateStyle, MessageDescriptor> =
	{
		classic: msg`Classic`,
		bold: msg`Bold`,
		minimal: msg`Minimal`,
	}

export const PRINT_QR_TARGET_LABELS: Record<
	PrintQrTarget['kind'],
	MessageDescriptor
> = {
	table: msg`Order at the table`,
	menu: msg`Order ahead (menu)`,
	reservations: msg`Book a table`,
	site: msg`A page on your website`,
	none: msg`No QR code`,
}
