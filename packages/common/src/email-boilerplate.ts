import { getDefaultEmailBlock, type EmailBlock } from './email-blocks.ts'

/**
 * Unedited starter text, in one place for automations and broadcasts.
 *
 * Two kinds: placeholder phrases a pasted-in template leaves behind (what the
 * automation validator always checked), and the designer's own starter copy:
 * the text a new heading, body, paragraph or button block starts with. The
 * starter copy is read from `getDefaultEmailBlock`, so changing a block's
 * default can never leave this check behind.
 */

export const BOILERPLATE_PHRASES = [
	'lorem ipsum',
	'insert text here',
	'default template text',
] as const

/** Whether any of the texts still holds a placeholder phrase. */
export function hasBoilerplatePhrase(
	...texts: ReadonlyArray<string | null | undefined>
): boolean {
	const combined = texts
		.filter((text): text is string => typeof text === 'string')
		.join(' ')
		.toLowerCase()
	return BOILERPLATE_PHRASES.some((phrase) => combined.includes(phrase))
}

function starterText(type: 'heading' | 'body' | 'paragraph' | 'button') {
	const block = getDefaultEmailBlock(type)
	if (block.type === 'button') return block.config.label.trim()
	if (
		block.type === 'heading' ||
		block.type === 'body' ||
		block.type === 'paragraph'
	) {
		return block.config.text.trim()
	}
	return ''
}

/** The ids of the text and button blocks that still say what a new block says. */
export function starterTextBlockIds(blocks: readonly EmailBlock[]): string[] {
	const starters = {
		heading: starterText('heading'),
		body: starterText('body'),
		paragraph: starterText('paragraph'),
		button: starterText('button'),
	}
	return blocks.flatMap((block) => {
		switch (block.type) {
			case 'heading':
			case 'body':
			case 'paragraph':
				return block.config.text.trim() === starters[block.type]
					? [block.id]
					: []
			case 'button':
				return block.config.label.trim() === starters.button ? [block.id] : []
			default:
				return []
		}
	})
}
