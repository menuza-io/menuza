/**
 * #394 and #192: the "Most ordered" rail crops each photo at its dish's focal
 * point and marks a dish in a photo test (photo A stays the source).
 * Run with `vitest -c vitest.astro.config.ts`.
 */
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { describe, expect, it } from 'vitest'
import PopularRow from './PopularRow.astro'

const card = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: id,
	priceLabel: '$10.00',
	soldOut: false,
	imageUrl: `https://cdn.test/${id}.jpg`,
	...extra,
})

async function render(cards: unknown[]) {
	const container = await AstroContainer.create()
	return container.renderToString(PopularRow as never, {
		props: {
			heading: 'Most ordered',
			labels: { previous: 'Previous', next: 'Next' },
			cards,
		},
	})
}

const photos = (html: string) => html.match(/<img\b[^>]*>/gu) ?? []

describe('popular rail photos', () => {
	it('crops each photo at its own focal point', async () => {
		const tags = photos(
			await render([
				card('top_left', { imageFocal: { x: 0, y: 0 } }),
				card('centre'),
			]),
		)
		expect(tags[0]).toContain('object-position: 0% 0%')
		expect(tags[1]).not.toContain('object-position')
	})

	it('serves photo A and only marks a dish in a test', async () => {
		const tags = photos(
			await render([
				card('tested', {
					photoTest: {
						id: 'test_abcdefgh',
						imageUrlB: 'https://cdn.test/tested-b.jpg',
						imageFocalB: null,
					},
				}),
				card('plain'),
			]),
		)
		expect(tags[0]).toContain('src="https://cdn.test/tested.jpg"')
		expect(tags[0]).toContain('data-photo-test-id="test_abcdefgh"')
		expect(tags[0]).toContain('data-photo-test-item="tested"')
		expect(tags[0]).toContain(
			'data-photo-test-src-b="https://cdn.test/tested-b.jpg"',
		)
		expect(tags[1]).not.toContain('data-photo-test')
	})
})

describe('favorites rail (#158)', () => {
	async function favorites(cards: unknown[] = []) {
		const container = await AstroContainer.create()
		return container.renderToString(PopularRow as never, {
			props: {
				variant: 'favorites',
				heading: 'Your favorites',
				labels: { previous: 'Previous', next: 'Next' },
				cards,
			},
		})
	}

	it('renders an empty, hidden rail for the browser to fill, even with no cards', async () => {
		const html = await favorites()
		expect(html).toContain('data-favorites-rail')
		expect(html).toMatch(/<section[^>]*\bhidden\b/u)
		expect(html).toContain('Your favorites')
		expect(html).toContain('id="favorites-heading"')
		expect(html).toContain('data-rail')
		expect(html).not.toContain('js-popular-card')
		expect(html).toContain('data-favorites-notice-slot')
	})

	it('keeps the popular rail hidden below two dishes and unhidden otherwise', async () => {
		const popular = await render([card('a')])
		expect(popular).not.toContain('data-popular-rail')
		const two = await render([card('a'), card('b')])
		expect(two).toContain('id="popular-heading"')
		expect(two).not.toContain('data-favorites-rail')
	})
})
