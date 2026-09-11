import { type EmailBlock } from '@repo/common/email-blocks'

/**
 * Plain-text rendering of a block list.
 *
 * React Email's own plaintext renderer transforms headings (it upper-cases
 * them), which would corrupt merge tokens like `{{firstName|there}}` into
 * `{{FIRSTNAME|THERE}}` and stop them resolving at send time. Deriving the text
 * from the blocks keeps tokens byte-identical to what the author wrote.
 */
export function blocksToPlainText(blocks: EmailBlock[]): string {
	const lines: string[] = []

	for (const block of blocks) {
		switch (block.type) {
			case 'heading':
			case 'body':
			case 'paragraph': {
				const text = block.config.text.trim()
				if (text) lines.push(text)
				break
			}
			case 'image': {
				const alt = block.config.alt.trim()
				if (alt) lines.push(alt)
				break
			}
			case 'button': {
				const label = block.config.label.trim()
				if (!label) break
				const url = block.config.url.trim()
				lines.push(url ? `${label}: ${url}` : label)
				break
			}
		}
	}

	return lines.join('\n\n')
}
