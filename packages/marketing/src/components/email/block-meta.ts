import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	EMAIL_BLOCK_TYPES,
	type EmailBlock,
	type EmailBlockType,
} from '@repo/common/email-blocks'
import { type IconName } from '@repo/ui/icon'

type BlockMetaSource = {
	label: ReturnType<typeof msg>
	description: ReturnType<typeof msg>
	icon: IconName
}

const BLOCK_TYPE_META: Record<EmailBlockType, BlockMetaSource> = {
	heading: {
		label: msg`Heading`,
		description: msg`A large title that opens a section.`,
		icon: 'file-text',
	},
	body: {
		label: msg`Body text`,
		description: msg`The main paragraph copy of your email.`,
		icon: 'message-square',
	},
	paragraph: {
		label: msg`Paragraph text`,
		description: msg`Smaller, muted supporting copy.`,
		icon: 'chat-bubble',
	},
	image: {
		label: msg`Image`,
		description: msg`A picture, logo, or product shot.`,
		icon: 'image',
	},
	button: {
		label: msg`Button`,
		description: msg`A link styled as a call to action.`,
		icon: 'move-up-right',
	},
	menu_item: {
		label: msg`Menu item`,
		description: msg`One to three dishes with photo, price and an Order button.`,
		icon: 'utensils',
	},
	coupon: {
		label: msg`Coupon`,
		description: msg`The offer, each guest's code, its terms and a Use it now button.`,
		icon: 'tag',
	},
}

export type EmailBlockTypeOption = {
	type: EmailBlockType
	label: string
	description: string
	icon: IconName
}

/**
 * The block types an author can add. The coupon block is offered only when the
 * message carries a coupon (`couponAvailable`), and the dish block only when the
 * host can pick dishes (`menuItemsAvailable`); blocks already in a draft always
 * keep their label.
 */
export function useEmailBlockTypes(
	options: { couponAvailable?: boolean; menuItemsAvailable?: boolean } = {},
) {
	const { _ } = useLingui()
	const offered = EMAIL_BLOCK_TYPES.filter(
		(type) =>
			(type !== 'coupon' || options.couponAvailable) &&
			(type !== 'menu_item' || options.menuItemsAvailable),
	)
	const allTypes: EmailBlockTypeOption[] = EMAIL_BLOCK_TYPES.map((type) => ({
		type,
		label: _(BLOCK_TYPE_META[type].label),
		description: _(BLOCK_TYPE_META[type].description),
		icon: BLOCK_TYPE_META[type].icon,
	}))

	const blockTypes = allTypes.filter((option) => offered.includes(option.type))

	return {
		blockTypes,
		getBlockType: (type: EmailBlockType) =>
			allTypes.find((option) => option.type === type) ?? allTypes[0]!,
	}
}

export function emailBlockPreviewText(block: EmailBlock): string {
	switch (block.type) {
		case 'heading':
		case 'body':
		case 'paragraph':
			return block.config.text.trim()
		case 'image':
			return block.config.alt.trim() || block.config.url.trim()
		case 'button':
			return block.config.label.trim() || block.config.url.trim()
		case 'menu_item':
			return (block.config.snapshot?.items ?? [])
				.map((item) => item.name)
				.join(', ')
		case 'coupon':
			return ''
	}
}
