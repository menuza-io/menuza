import {
	createEmailBlockId,
	emailBlocksSchema,
	type EmailBlock,
} from '@repo/common/email-blocks'
import { occasionCopy, occasionTitle, type OccasionKey } from './occasions.ts'

/**
 * The ready-made campaign of an occasion (#152): an email design (heading, a
 * line of welcome, an Order button), the same words as a text and as a social
 * post. The email's colours, logo and fonts are not chosen here: the App
 * renders these blocks in the organization's own branding like any other
 * designed email. No offer, price or claim is invented: the words only greet
 * and point to the menu.
 */
export type OccasionMessage = {
	/** The broadcast's own name, for the operator's list. */
	name: string
	subject: string
	/** The email design. */
	blocks: EmailBlock[]
	/** The email's words as plain text. */
	emailText: string
	/** A text message, with the link to order. */
	sms: string
	/** An optional social post. */
	social: string
}

export function buildOccasionMessage(input: {
	key: OccasionKey
	locale: string
	restaurant: string
	/** The organization's own site, e.g. `https://casa-verde.menuza.site`. */
	siteOrigin: string
	/** The year, to tell one year's broadcast from the last in the list. */
	year: number
}): OccasionMessage {
	const link = `${input.siteOrigin.replace(/\/$/, '')}/menu`
	const copy = occasionCopy(input.key, input.locale, {
		restaurant: input.restaurant,
		link,
	})
	const blocks = emailBlocksSchema.parse([
		{
			id: createEmailBlockId(),
			type: 'heading',
			config: { text: copy.headline, level: 'h1', align: 'center' },
		},
		{
			id: createEmailBlockId(),
			type: 'body',
			config: { text: copy.body, align: 'center' },
		},
		{
			id: createEmailBlockId(),
			type: 'button',
			config: {
				label: copy.buttonLabel,
				url: link,
				variant: 'primary',
				width: 'auto',
				align: 'center',
			},
		},
	])
	return {
		name: `${occasionTitle(input.key, input.locale)} ${input.year}`,
		subject: copy.subject,
		blocks,
		emailText: `${copy.headline}\n\n${copy.body}\n\n${link}`,
		sms: copy.sms,
		social: copy.social,
	}
}
