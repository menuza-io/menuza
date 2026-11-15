import { resolveEmailTheme } from '@repo/common/email-theme'
import { interpolateMergeTagsHtml } from '@repo/tenant-db'
import { describe, expect, it } from 'vitest'

import {
	normalizeEmailBlocks,
	renderMarketingEmail,
} from './email-render.server'

const theme = resolveEmailTheme({ organizationName: 'Acme' })

describe('normalizeEmailBlocks', () => {
	it('keeps valid blocks and drops invalid or duplicate ones', () => {
		const blocks = normalizeEmailBlocks([
			{ id: 'block-1', type: 'heading', config: { text: 'Hi' } },
			{ id: 'block-1', type: 'body', config: { text: 'dup' } },
			{ id: 'block-2', type: 'nope', config: {} },
			{ id: 'block-3', type: 'body', config: { text: 'ok' } },
		])
		expect(blocks.map((block) => block.id)).toEqual(['block-1', 'block-3'])
	})

	it('handles strings and malformed input', () => {
		expect(normalizeEmailBlocks('not json')).toEqual([])
		expect(normalizeEmailBlocks(null)).toEqual([])
	})
})

describe('renderMarketingEmail', () => {
	it('renders html and plaintext for a block set', async () => {
		const { html, text } = await renderMarketingEmail({
			blocks: [
				{ id: 'block-1', type: 'heading', config: { text: 'Order shipped' } },
				{ id: 'block-2', type: 'body', config: { text: 'Hi {{firstName}}' } },
				{
					id: 'block-3',
					type: 'button',
					config: { label: 'Track order', url: 'https://example.com' },
				},
			],
			theme,
			subject: 'Order shipped',
		})

		expect(html).toContain('<!DOCTYPE html')
		expect(html).toContain('Order shipped')
		expect(html).toContain('Track order')
		expect(text.toLowerCase()).toContain('order shipped')
		expect(text).not.toContain('<')
	})

	it('leaves merge tags with fallbacks for send-time interpolation', async () => {
		const { html, text } = await renderMarketingEmail({
			blocks: [
				{
					id: 'block-1',
					type: 'heading',
					config: { text: 'Hey {{firstName|there}}' },
				},
			],
			theme,
		})

		// Design-time rendering must not resolve tags; tenant-api/platform
		// dispatch substitutes them per recipient.
		expect(html).toContain('{{firstName|there}}')
		expect(text).toContain('{{firstName|there}}')
	})
})

describe('restaurant blocks through the send path', () => {
	const context = {
		direction: 'ltr' as const,
		locale: 'en',
		siteOrigin: 'https://acme.site.test',
		coupon: {
			headline: '10% off',
			terms: 'Online orders only.',
			buttonLabel: 'Use it now',
		},
	}
	const blocks = [
		{ id: 'block-coupon', type: 'coupon', config: { style: 'box' } },
	]

	it('fills each guest code into the text and the button link, escaped', async () => {
		const { html, text } = await renderMarketingEmail({
			blocks,
			theme,
			context,
		})
		expect(text).toContain('{{couponCode}}')

		const sent = interpolateMergeTagsHtml(
			html,
			{ name: 'Sam' },
			{ couponCode: 'SAVE10' },
		)
		expect(sent).toContain('href="https://acme.site.test/menu?coupon=SAVE10"')
		expect(sent).not.toContain('{{couponCode}}')

		// A hostile value cannot break out of the attribute or the text.
		const hostile = interpolateMergeTagsHtml(
			html,
			{ name: 'Sam' },
			{ couponCode: 'A" onmouseover="x' },
		)
		expect(hostile).not.toContain('onmouseover="x')
		expect(hostile).toContain('&quot;')
	})

	it('renders the coupon in Arabic RTL with the coupon words it was given', async () => {
		const { html } = await renderMarketingEmail({
			blocks,
			theme,
			context: {
				...context,
				direction: 'rtl',
				locale: 'ar',
				coupon: {
					headline: 'خصم 10%',
					terms: 'للطلبات عبر الإنترنت فقط.',
					buttonLabel: 'استخدمه الآن',
				},
			},
		})
		expect(html).toContain('dir="rtl"')
		expect(html).toContain('خصم 10%')
		expect(html).toContain('استخدمه الآن')
	})
})
