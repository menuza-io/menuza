// @vitest-environment jsdom
/**
 * #318: a click on a button that leaves for another site is counted as one
 * number: no visitor, no address, no destination.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initOutboundClicks } from './site-funnel-client'

const context = {
	tenantApiUrl: 'https://tenant.example',
	orgSlug: 'acme',
}

let posts: Array<{ url: string; body: Record<string, unknown> }>
// A fresh element per test, so an earlier test's listener never sees a click.
let host: HTMLElement

beforeEach(() => {
	posts = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: { body: string }) => {
			posts.push({
				url,
				body: JSON.parse(init.body) as Record<string, unknown>,
			})
			return new Response(null, { status: 204 })
		}),
	)
	document.body.innerHTML = '<div id="host"></div>'
	host = document.getElementById('host')!
	host.innerHTML = `
		<a id="order" href="https://order.example" data-outbound="order"><span id="inner">Order</span></a>
		<a id="gift" href="https://gift.example" data-outbound="gift_cards">Gift</a>
		<a id="book" href="https://book.example" data-outbound="reservations">Book</a>
		<a id="plain" href="/about">About</a>
		<a id="bogus" href="https://evil.example" data-outbound="purchase">Bogus</a>`
	Object.defineProperty(window, 'innerWidth', {
		value: 1280,
		configurable: true,
	})
})
afterEach(() => vi.unstubAllGlobals())

const click = (id: string) => host.querySelector<HTMLElement>(`#${id}`)!.click()

describe('outbound click counting', () => {
	it('counts every click on an outbound button, per action', () => {
		initOutboundClicks(context, host)
		click('order')
		click('order')
		click('inner')
		click('gift')
		click('book')
		expect(posts.map((post) => post.body.event)).toEqual([
			'outbound_order',
			'outbound_order',
			'outbound_order',
			'outbound_gift_cards',
			'outbound_reservations',
		])
		expect(
			posts.every(
				(post) => post.url === 'https://tenant.example/forms/site-events',
			),
		).toBe(true)
	})

	it('counts a middle click, which opens the link without a click event, and no other button', () => {
		initOutboundClicks(context, host)
		const aux = (id: string, button: number) =>
			host
				.querySelector<HTMLElement>(`#${id}`)!
				.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button }))
		aux('order', 1)
		aux('gift', 2)
		aux('plain', 1)
		expect(posts.map((post) => post.body.event)).toEqual(['outbound_order'])
	})

	it('sends counts only: no visitor id, address, user agent or destination', () => {
		initOutboundClicks(context, host)
		click('order')
		const body = posts[0]!.body
		expect(Object.keys(body).sort()).toEqual(
			['device', 'entry', 'event', 'slug'].sort(),
		)
		expect(JSON.stringify(body)).not.toContain('order.example')
		expect(body).toMatchObject({
			event: 'outbound_order',
			device: 'desktop',
			slug: 'acme',
		})
	})

	it('ignores ordinary links and unknown kinds', () => {
		initOutboundClicks(context, host)
		click('plain')
		click('bogus')
		expect(posts).toHaveLength(0)
	})

	it('counts nothing without a tenant address or when the visitor asks not to be tracked', () => {
		initOutboundClicks({ ...context, tenantApiUrl: '' }, host)
		click('order')
		expect(posts).toHaveLength(0)
		vi.stubGlobal('navigator', { ...navigator, doNotTrack: '1' })
		const second = host.cloneNode(true) as HTMLElement
		host.replaceWith(second)
		host = second
		initOutboundClicks(context, host)
		click('order')
		expect(posts).toHaveLength(0)
	})
})
