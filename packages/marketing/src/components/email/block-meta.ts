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
}

export type EmailBlockTypeOption = {
	type: EmailBlockType
	label: string
	description: string
	icon: IconName
}

export function useEmailBlockTypes() {
	const { _ } = useLingui()
	const blockTypes: EmailBlockTypeOption[] = EMAIL_BLOCK_TYPES.map((type) => ({
		type,
		label: _(BLOCK_TYPE_META[type].label),
		description: _(BLOCK_TYPE_META[type].description),
		icon: BLOCK_TYPE_META[type].icon,
	}))

	return {
		blockTypes,
		getBlockType: (type: EmailBlockType) =>
			blockTypes.find((option) => option.type === type) ?? blockTypes[0]!,
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
	}
}
