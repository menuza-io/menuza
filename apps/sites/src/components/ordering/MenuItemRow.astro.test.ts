/**
 * #394 and #192: a menu card crops its photo at the dish's focal point and,
 * while the dish is in a photo test, shows photo A and only carries the
 * markers (the menu is cached for everybody; the browser swaps to B).
 * Run with `vitest -c vitest.astro.config.ts`.
 */
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { describe, expect, it } from 'vitest'
import MenuItemRow from './MenuItemRow.astro'

async function render(props: Record<string, unknown>) {
	const container = await AstroContainer.create()
	return container.renderToString(MenuItemRow as never, {
		props: {
			id: 'dish_1',
			name: 'Burger',
			priceLabel: '$12.00',
			soldOut: false,
			imageUrl: 'https://cdn.test/a.jpg',
			labels: { vegetarian: 'V', glutenFree: 'GF', alcohol: 'A' },
			...props,
		},
	})
}

const img = (html: string) => /<img\b[^>]*>/u.exec(html)![0]

describe('menu card photo', () => {
	it('crops toward a top-left focal point', async () => {
		const tag = img(await render({ imageFocal: { x: 0, y: 0 } }))
		expect(tag).toContain('object-position: 0% 0%')
	})

	it('keeps the default centre crop without a focal point', async () => {
		expect(img(await render({}))).not.toContain('object-position')
		expect(img(await render({ imageFocal: null }))).not.toContain(
			'object-position',
		)
	})

	it('renders photo A as the source and only marks photo B', async () => {
		const html = await render({
			photoTest: {
				id: 'test_abcdefgh',
				imageUrlB: 'https://cdn.test/b.jpg',
				imageFocalB: { x: 1, y: 0 },
			},
		})
		const tag = img(html)
		expect(tag).toContain('src="https://cdn.test/a.jpg"')
		expect(tag).toContain('data-photo-test-id="test_abcdefgh"')
		expect(tag).toContain('data-photo-test-item="dish_1"')
		expect(tag).toContain('data-photo-test-src-b="https://cdn.test/b.jpg"')
		expect(tag).toContain('data-photo-test-focal-b="1,0"')
		expect(html.match(/b\.jpg/gu)).toHaveLength(1)
	})

	it('has no markers for a dish that is not in a test', async () => {
		expect(img(await render({}))).not.toContain('data-photo-test')
	})
})
