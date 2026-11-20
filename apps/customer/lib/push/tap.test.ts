import { buildLink } from '@repo/common/links'
import { pushPayloadSchema } from '@repo/common/push'
import { destinationForPush } from './tap'

const bound = {
	siteAddress: {
		slug: 'acme',
		host: 'acme.menuza.io',
		origin: 'https://acme.menuza.io',
	},
}
const HEX = 'd'.repeat(64)

describe('where a tapped push goes (#105, #195)', () => {
	it('an order push opens the order screen', () => {
		const url = buildLink(
			'order',
			{ order: 'ord_9', link: HEX },
			{ origin: 'https://acme.menuza.io' },
		)!
		expect(
			destinationForPush(
				{ url, messageId: 'm1', kind: 'order_status' },
				bound,
				'ios',
			),
		).toEqual({
			kind: 'screen',
			pathname: '/orders/ord_9',
			params: { link: HEX },
		})
	})

	it('a booking push opens the reservations tab, a reward push the rewards tab', () => {
		const booking = buildLink(
			'reserve',
			{},
			{ origin: 'https://acme.menuza.io' },
		)!
		const reward = buildLink(
			'loyalty',
			{},
			{ origin: 'https://acme.menuza.io' },
		)!
		expect(
			destinationForPush({ url: booking }, bound, 'android'),
		).toMatchObject({ kind: 'screen', pathname: '/reservations' })
		expect(destinationForPush({ url: reward }, bound, 'android')).toMatchObject(
			{ kind: 'screen', pathname: '/rewards' },
		)
	})

	it('a link to another restaurant opens that website, never a screen', () => {
		const url = buildLink(
			'order',
			{ order: 'o1' },
			{ origin: 'https://other.menuza.io' },
		)!
		expect(destinationForPush({ url }, bound, 'ios')).toEqual({
			kind: 'web',
			url,
		})
	})

	it('a push with no link, or a malformed one, opens the app where it is', () => {
		expect(destinationForPush({ url: null }, bound, 'ios')).toEqual({
			kind: 'none',
		})
		expect(destinationForPush({}, bound, 'ios')).toEqual({ kind: 'none' })
		expect(destinationForPush({ url: 'not a url' }, bound, 'ios')).toEqual({
			kind: 'none',
		})
	})

	it('the payload contract names only a title, a body and a link (no personal data)', () => {
		const payload = {
			title: 'Order 12 is ready',
			body: 'Your order is ready for pickup.',
			data: {
				kind: 'order_status',
				url: 'https://acme.menuza.io/orders/ord_9',
				messageId: 'm1',
			},
		}
		expect(pushPayloadSchema.safeParse(payload).success).toBe(true)
		expect(
			pushPayloadSchema.safeParse({
				...payload,
				data: { ...payload.data, customer: 'Ada' },
			}).success,
		).toBe(false)
	})
})
