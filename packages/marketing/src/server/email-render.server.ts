import { render } from '@react-email/components'
import { emailBlockSchema, type EmailBlock } from '@repo/common/email-blocks'
import { type EmailTheme } from '@repo/common/email-theme'
import {
	blocksToPlainText,
	DEFAULT_UNSUBSCRIBE_TEXT,
	EmailDocument,
	type EmailSocialLink,
} from '@repo/email/marketing'
import { createElement } from 'react'

export type RenderMarketingEmailInput = {
	blocks: unknown
	theme: EmailTheme
	socials?: EmailSocialLink[]
	/** Inbox preview text; usually the subject line. */
	subject?: string
}

export type RenderedMarketingEmail = {
	html: string
	text: string
}

/** Keep valid blocks in order, dropping malformed ones and de-duplicating ids. */
export function normalizeEmailBlocks(value: unknown): EmailBlock[] {
	let raw = value
	if (typeof value === 'string') {
		if (value.trim().length === 0) return []
		try {
			raw = JSON.parse(value)
		} catch {
			return []
		}
	}
	if (!Array.isArray(raw)) return []

	const seen = new Set<string>()
	const blocks: EmailBlock[] = []
	for (const candidate of raw) {
		const parsed = emailBlockSchema.safeParse(candidate)
		if (!parsed.success) continue
		if (seen.has(parsed.data.id)) continue
		seen.add(parsed.data.id)
		blocks.push(parsed.data)
	}
	return blocks
}

/**
 * Render a marketing email body to `{ html, text }` using React Email.
 *
 * Runs at design time (broadcast creation / automation save); the regional send
 * paths only interpolate merge tags afterwards, so no React ships to tenant-api.
 */
export async function renderMarketingEmail(
	input: RenderMarketingEmailInput,
): Promise<RenderedMarketingEmail> {
	const blocks = normalizeEmailBlocks(input.blocks)
	const element = createElement(EmailDocument, {
		blocks,
		theme: input.theme,
		socials: input.socials,
		previewText: input.subject,
	})

	// The text part is derived from the blocks rather than React Email's
	// plaintext renderer, which upper-cases headings and would corrupt merge
	// tokens before they reach the send path.
	const html = await render(element)
	const text = [blocksToPlainText(blocks), DEFAULT_UNSUBSCRIBE_TEXT]
		.filter(Boolean)
		.join('\n\n')

	return { html, text }
}
