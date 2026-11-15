import { type EmailRenderContext } from '@repo/common/email-block-base'
import { type EmailBlock } from '@repo/common/email-blocks'
import {
	EMAIL_COUPON_BUTTON_PATH,
	emailSiteUrl,
	formatEmailPrice,
} from '@repo/common/email-blocks-restaurant'

/**
 * Plain-text rendering of a block list.
 *
 * React Email's own plaintext renderer transforms headings (it upper-cases
 * them), which would corrupt merge tokens like `{{firstName|there}}` into
 * `{{FIRSTNAME|THERE}}` and stop them resolving at send time. Deriving the text
 * from the blocks keeps tokens byte-identical to what the author wrote.
 */
export function blocksToPlainText(
	blocks: EmailBlock[],
	context: EmailRenderContext = {},
): string {
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
			case 'menu_item': {
				for (const item of block.config.snapshot?.items ?? []) {
					const price =
						block.config.showPrice && item.priceMinor !== null
							? ` - ${formatEmailPrice(item.priceMinor, item.currency, context.locale ?? 'en')}`
							: ''
					const link = emailSiteUrl(context, item.path)
					lines.push(`${item.name}${price}${link ? `\n${link}` : ''}`)
				}
				break
			}
			case 'coupon': {
				const coupon = context.coupon
				if (!coupon) break
				const link = emailSiteUrl(context, EMAIL_COUPON_BUTTON_PATH)
				lines.push(
					[coupon.headline, '{{couponCode}}', coupon.terms, link]
						.filter(Boolean)
						.join('\n'),
				)
				break
			}
		}
	}

	return lines.join('\n\n')
}
