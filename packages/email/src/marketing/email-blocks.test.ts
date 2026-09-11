import { render } from '@react-email/components'
import {
	buildEmailTemplateBlocks,
	getDefaultEmailBlock,
} from '@repo/common/email-blocks'
import { resolveEmailTheme } from '@repo/common/email-theme'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import { EmailBody } from './components/email-body.tsx'
import { EmailDocument } from './components/email-document.tsx'

const theme = resolveEmailTheme({
	organizationName: 'Acme',
	logoUrl: '/resources/images?objectKey=org-1/site-icon/logo.png',
	appUrl: 'https://app.test',
})

describe('marketing email renderer', () => {
	it('renders a full document with branded inline styles', async () => {
		const blocks = [
			getDefaultEmailBlock('heading'),
			getDefaultEmailBlock('body'),
			getDefaultEmailBlock('button'),
		]

		const html = await render(
			createElement(EmailDocument, {
				blocks,
				theme,
				previewText: 'Hello',
			}),
		)

		expect(html).toContain('<!DOCTYPE html')
		expect(html).toContain(theme.primary)
		expect(html).toContain(
			'https://app.test/resources/images?objectKey=org-1/site-icon/logo.png',
		)
		expect(html).toContain('unsubscribe')
		expect(html).toContain('Acme')
	})

	it('resolves relative image urls and applies alignment', async () => {
		const block = getDefaultEmailBlock('image')
		if (block.type !== 'image') throw new Error('expected image block')
		block.config.url = '/resources/images?objectKey=org-1/asset.png'
		block.config.align = 'right'

		const html = await render(
			createElement(EmailBody, { blocks: [block], theme }),
		)

		expect(html).toContain(
			'https://app.test/resources/images?objectKey=org-1/asset.png',
		)
		expect(html).toMatch(/text-align:\s*right/)
	})

	it('tints the page when the theme background and card are the same color', async () => {
		// Default light presets resolve both to white; the card would be invisible
		// without a distinct page background.
		const flatTheme = resolveEmailTheme({ organizationName: 'Acme' })
		expect(flatTheme.background).toBe(flatTheme.card)

		const html = await render(
			createElement(EmailBody, {
				blocks: [getDefaultEmailBlock('body')],
				theme: flatTheme,
			}),
		)

		expect(html).toContain(flatTheme.muted)
		expect(flatTheme.muted.toLowerCase()).not.toBe(flatTheme.card.toLowerCase())
	})

	it('preserves authored line breaks as <br /> in body and paragraph text', async () => {
		const body = getDefaultEmailBlock('body')
		if (body.type !== 'body') throw new Error('expected body block')
		body.config.text = 'First line\nSecond line'

		const paragraph = getDefaultEmailBlock('paragraph')
		if (paragraph.type !== 'paragraph')
			throw new Error('expected paragraph block')
		paragraph.config.text = 'Alpha\nBeta'

		const html = await render(
			createElement(EmailBody, { blocks: [body, paragraph], theme }),
		)

		expect(html).toContain('First line<br/>Second line')
		expect(html).toContain('Alpha<br/>Beta')
		// Whitespace collapsing would silently join the lines on one row.
		expect(html).not.toContain('First line Second line')
	})

	it('renders a full-width button across the content width', async () => {
		const block = getDefaultEmailBlock('button')
		if (block.type !== 'button') throw new Error('expected button block')
		block.config.width = 'full'
		block.config.align = 'left'

		const html = await render(
			createElement(EmailBody, { blocks: [block], theme }),
		)

		// The anchor becomes a block that spans, with a centred label.
		expect(html).toMatch(/display:\s*block/)
		expect(html).toMatch(/width:\s*100%/)
		expect(html).toMatch(/box-sizing:\s*border-box/)
		expect(html).toMatch(/text-align:\s*center/)
		// Alignment no longer applies to a full-width button.
		expect(html).not.toMatch(/text-align:\s*left/)
	})

	it('keeps auto-width buttons content-sized', async () => {
		const block = getDefaultEmailBlock('button')
		if (block.type !== 'button') throw new Error('expected button block')
		expect(block.config.width).toBe('auto')
		block.config.align = 'left'

		const html = await render(
			createElement(EmailBody, { blocks: [block], theme }),
		)

		expect(html).toMatch(/display:\s*inline-block/)
		expect(html).not.toMatch(/box-sizing:\s*border-box/)
		expect(html).toMatch(/text-align:\s*left/)
	})

	it('renders single-line text without stray breaks', async () => {
		const body = getDefaultEmailBlock('body')
		if (body.type !== 'body') throw new Error('expected body block')
		body.config.text = 'One line only'

		const html = await render(
			createElement(EmailBody, { blocks: [body], theme }),
		)

		expect(html).toContain('One line only')
		expect(html).not.toContain('<br/>')
	})

	it('renders email-body without document wrappers for the editor preview', async () => {
		const html = await render(
			createElement(EmailBody, {
				blocks: buildEmailTemplateBlocks('welcome'),
				theme,
			}),
		)

		expect(html).not.toMatch(/<body[\s>]/)
		expect(html).toContain('Welcome')
	})
})
