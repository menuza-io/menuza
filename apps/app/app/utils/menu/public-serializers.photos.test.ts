import { describe, expect, it } from 'vitest'
import {
	serializePublicMenuItem,
	serializePublicOption,
	type MediaUrlMap,
} from './public-serializers.server.ts'

const now = new Date('2026-01-01T00:00:00Z')

function item(overrides: Record<string, unknown> = {}) {
	return {
		id: 'item-1',
		displayName: 'Margherita',
		internalName: null,
		kitchenName: null,
		kitchenHighlight: null,
		description: null,
		price: 1000,
		imageKey: 'orgs/o/media/a.jpg',
		imageKeys: JSON.stringify(['orgs/o/media/a.jpg', 'orgs/o/media/b.jpg']),
		imageUrl: null,
		variations: null,
		...overrides,
	} as never
}

const urls: MediaUrlMap = new Map([
	['orgs/o/media/a.jpg', '/resources/images?mediaId=a&v=1'],
	['orgs/o/media/b.jpg', '/resources/images?mediaId=b&v=1'],
])

describe('public menu photos (#394, #192)', () => {
	it('carries no focal field for photos that have none (centre crops stay)', () => {
		const serialized = serializePublicMenuItem(item(), [], urls, now)
		expect(serialized).not.toHaveProperty('imageFocal')
		expect(serialized).not.toHaveProperty('imageFocals')
		expect(serialized).not.toHaveProperty('photoTest')
	})

	it('carries the focal point of the primary photo and parallel focal points', () => {
		const serialized = serializePublicMenuItem(item(), [], urls, now, {
			focalMap: new Map([['orgs/o/media/a.jpg', { x: 0, y: 0 }]]),
		})
		expect(serialized.imageFocal).toEqual({ x: 0, y: 0 })
		expect(serialized.imageFocals).toEqual([{ x: 0, y: 0 }, null])
		expect(serialized.imageUrls).toHaveLength(2)
	})

	it('carries the focal point of an option', () => {
		const option = serializePublicOption(
			{
				id: 'o1',
				displayName: 'Extra',
				imageKey: 'orgs/o/media/a.jpg',
			} as never,
			urls,
			now,
			{ focalMap: new Map([['orgs/o/media/a.jpg', { x: 1, y: 0.2 }]]) },
		)
		expect(option.imageFocal).toEqual({ x: 1, y: 0.2 })
	})

	it('adds photo B only when a test is passed, and keeps photo A as imageUrl', () => {
		const serialized = serializePublicMenuItem(item(), [], urls, now, {
			photoTests: new Map([
				[
					'item-1',
					{
						id: 'test-12345678',
						imageUrlB: '/resources/images?mediaId=b&v=1',
						imageFocalB: null,
						key: 'k'.repeat(32),
					},
				],
			]),
		})
		expect(serialized.imageUrl).toBe('/resources/images?mediaId=a&v=1')
		expect(serialized.photoTest).toEqual({
			id: 'test-12345678',
			imageUrlB: '/resources/images?mediaId=b&v=1',
			imageFocalB: null,
			key: 'k'.repeat(32),
		})
		const other = serializePublicMenuItem(
			item({ id: 'item-2' }),
			[],
			urls,
			now,
			{
				photoTests: new Map([
					[
						'item-1',
						{ id: 't', imageUrlB: 'x', imageFocalB: null, key: 'k'.repeat(32) },
					],
				]),
			},
		)
		expect(other).not.toHaveProperty('photoTest')
	})
})
