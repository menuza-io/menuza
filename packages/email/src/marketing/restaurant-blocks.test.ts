import { render } from '@react-email/components'
import { type EmailRenderContext } from '@repo/common/email-block-base'
import {
	getDefaultEmailBlock,
	type EmailBlock,
} from '@repo/common/email-blocks'
import { resolveEmailTheme } from '@repo/common/email-theme'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import { blocksToPlainText } from './blocks-to-text.ts'
import { EmailDocument } from './components/email-document.tsx'

const theme = resolveEmailTheme({
	organizationName: 'Acme',
	appUrl: 'https://app.test',
})

function dish(name: string, id = 'item-1'): EmailBlock {
	return {
		id: 'block-dish',
		type: 'menu_item',
		config: {
			itemIds: [id],
			locationId: null,
			showPrice: true,
			showDescription: true,
			snapshot: {
				resolvedAt: '2026-11-15T00:00:00.000Z',
				items: [
					{
						itemId: id,
						name,
						description: 'Smoked <i>12</i> hours',
						priceMinor: 1250,
						currency: 'USD',
						imageUrl: 'https://app.test/resources/images?objectKey=a.png',
						path: `/menu?item=${id}`,
					},
				],
			},
		},
	}
}

const coupon = (): EmailBlock => ({
	id: 'block-coupon',
	type: 'coupon',
	config: { style: 'box' },
})

const COPY = {
	headline: '10% off',
	terms: 'Valid until November 30, 2026. Online orders only.',
	buttonLabel: 'Use it now',
}

const ltr: EmailRenderContext = {
	direction: 'ltr',
	locale: 'en',
	siteOrigin: 'https://acme.site.test',
	coupon: COPY,
}

function renderBlocks(blocks: EmailBlock[], context = ltr) {
	return render(createElement(EmailDocument, { blocks, theme, context }))
}

describe('restaurant email blocks', () => {
	it('renders a dish with photo, name, price and an Order link (LTR)', async () => {
		const html = await renderBlocks([dish('Brisket sandwich')])
		expect(html).toContain('dir="ltr"')
		expect(html).toContain('Brisket sandwich')
		expect(html).toContain('$12.50')
		expect(html).toContain('Smoked')
		expect(html).toContain('href="https://acme.site.test/menu?item=item-1"')
		expect(html).toContain('>Order<')
		expect(html).toContain('https://app.test/resources/images?objectKey=a.png')
	})

	it('renders right-to-left with an Arabic label and price (RTL)', async () => {
		const html = await renderBlocks([dish('ساندويتش'), coupon()], {
			...ltr,
			direction: 'rtl',
			locale: 'ar',
		})
		expect(html).toContain('dir="rtl"')
		expect(html).toContain('lang="ar"')
		expect(html).toContain('ساندويتش')
		expect(html).toContain('اطلب')
		expect(html).toMatch(/text-align:\s*right/)
		expect(html).not.toContain('>Order<')
	})

	it('escapes dish text and never emits HTML from stored values', async () => {
		const html = await renderBlocks([dish('<script>alert(1)</script>')])
		expect(html).not.toContain('<script>alert(1)</script>')
		expect(html).toContain('&lt;script&gt;')
		expect(html).toContain('Smoked &lt;i&gt;12&lt;/i&gt; hours')
	})

	it('hides price and description on request, and skips an unresolved dish', async () => {
		const block = dish('Brisket sandwich')
		if (block.type !== 'menu_item') throw new Error('expected menu_item')
		block.config.showPrice = false
		block.config.showDescription = false
		const html = await renderBlocks([block])
		expect(html).not.toContain('$12.50')
		expect(html).not.toContain('Smoked')

		const empty = dish('x')
		if (empty.type !== 'menu_item') throw new Error('expected menu_item')
		empty.config.snapshot = null
		expect(await renderBlocks([empty])).not.toContain('data-block="menu_item"')
	})

	it('drops the Order link when the site origin is unknown', async () => {
		const html = await renderBlocks([dish('Brisket')], {
			...ltr,
			siteOrigin: undefined as unknown as string,
		})
		expect(html).toContain('Brisket')
		expect(html).not.toContain('/menu?item=')
	})

	it('renders the coupon box with the code tag and a menu link', async () => {
		const html = await renderBlocks([coupon()])
		expect(html).toContain('10% off')
		expect(html).toContain('{{couponCode}}')
		expect(html).toContain('Valid until November 30, 2026')
		expect(html).toContain(
			'href="https://acme.site.test/menu?coupon={{couponCode}}"',
		)
		expect(html).toContain('Use it now')
	})

	it('shows no coupon block when the message carries no coupon', async () => {
		const html = await renderBlocks([coupon()], {
			...ltr,
			coupon: undefined as never,
		})
		expect(html).not.toContain('data-block="coupon"')
		expect(html).not.toContain('{{couponCode}}')
	})

	it('adds dishes and the coupon to the plain-text part', () => {
		const text = blocksToPlainText(
			[getDefaultEmailBlock('heading'), dish('Brisket sandwich'), coupon()],
			ltr,
		)
		expect(text).toContain('Brisket sandwich - $12.50')
		expect(text).toContain('https://acme.site.test/menu?item=item-1')
		expect(text).toContain('{{couponCode}}')
		expect(text).toContain('10% off')
	})
})
