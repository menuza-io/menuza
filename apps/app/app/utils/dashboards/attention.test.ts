import { describe, expect, it } from 'vitest'
import {
	ATTENTION_KINDS,
	ATTENTION_MAX_ITEMS,
	ATTENTION_URGENCY,
	attentionItem,
	attentionKey,
	isDismissibleKind,
	orderAttentionItems,
	parseAttentionKey,
} from './attention.ts'

const olaya = { id: 'loc_olaya', name: 'Olaya' }

describe('attention keys', () => {
	it('keys an item by kind and location', () => {
		expect(attentionKey('channel_off', 'loc_olaya')).toBe(
			'channel_off:loc_olaya',
		)
		expect(attentionKey('site_unpublished', null)).toBe('site_unpublished:org')
		expect(parseAttentionKey('channel_off:loc_olaya')).toEqual({
			kind: 'channel_off',
			locationId: 'loc_olaya',
		})
		expect(parseAttentionKey('site_unpublished:org')).toEqual({
			kind: 'site_unpublished',
			locationId: null,
		})
	})

	it('refuses malformed keys and unknown kinds', () => {
		for (const key of [
			'',
			'nope:org',
			'channel_off',
			'channel_off:a b',
			'x:y:z',
		]) {
			expect(parseAttentionKey(key)).toBeNull()
		}
	})
})

describe('urgency and dismissal', () => {
	it('never lets an urgent kind be dismissed', () => {
		expect(isDismissibleKind('payments_not_connected')).toBe(false)
		expect(isDismissibleKind('payment_review')).toBe(false)
		for (const kind of ATTENTION_KINDS) {
			expect(isDismissibleKind(kind)).toBe(ATTENTION_URGENCY[kind] !== 'urgent')
		}
	})
})

describe('orderAttentionItems', () => {
	it('puts urgent items first, then the newest', () => {
		const items = [
			attentionItem('menu_health_low', null, { href: '/menu' }),
			attentionItem('reviews_unanswered', null, {
				href: '/mailbox',
				since: '2026-05-01T00:00:00Z',
			}),
			attentionItem('channel_off', olaya, {
				href: '/settings',
				since: '2026-05-03T00:00:00Z',
			}),
			attentionItem('payments_not_connected', null, { href: '/settings/shop' }),
		]
		expect(orderAttentionItems(items).map((item) => item.kind)).toEqual([
			'payments_not_connected',
			'channel_off',
			'reviews_unanswered',
			'menu_health_low',
		])
	})

	it('hides dismissed advice but never a dismissed urgent item', () => {
		const items = [
			attentionItem('channel_off', olaya, { href: '/settings' }),
			attentionItem('payments_not_connected', null, { href: '/settings/shop' }),
		]
		const shown = orderAttentionItems(items, [
			'channel_off:loc_olaya',
			'payments_not_connected:org',
		])
		expect(shown.map((item) => item.kind)).toEqual(['payments_not_connected'])
	})

	it('shows at most 20 items', () => {
		const many = Array.from({ length: 30 }, (_, index) =>
			attentionItem(
				'no_hours',
				{ id: `loc_${index}`, name: `Place ${index}` },
				{
					href: '/settings',
				},
			),
		)
		expect(orderAttentionItems(many)).toHaveLength(ATTENTION_MAX_ITEMS)
	})
})
