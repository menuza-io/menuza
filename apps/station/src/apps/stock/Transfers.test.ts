// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { createElement as h } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import catalogFixture from './fixtures/catalog.json'
import { stockRows } from './queue.ts'
import { Stock } from './Stock.tsx'
import { ORIGIN, resetStock, session, settings } from './testing.ts'
import {
	button,
	click,
	hasButton,
	installDom,
	mount,
	region,
	text,
	type Page,
} from './ui-testing.ts'
import { type Session } from '~/lib/signin.ts'
import { usePos } from '~/lib/store.ts'

/**
 * Transfers on Station Stock (#515): the lists come from the catalogue on the
 * tablet, a branch receives a transfer (a short line stays missing in transit)
 * and the receipt is saved offline and sent when the tablet is back online;
 * requests offer only what the asked place gives out; no price or value shows.
 */

vi.setConfig({ testTimeout: 30_000 })

const fixture = catalogFixture as unknown as {
	settings: Record<string, unknown>
	transfers?: unknown
	transferItems?: unknown
	transferBlocked?: unknown
}

const line = (over: Record<string, unknown> = {}) => ({
	itemId: 'item_tomato',
	itemName: 'Tomatoes',
	baseUnit: 'g',
	countUnit: 'kg',
	units: [],
	requestedQuantity: 2_000_000,
	sentQuantity: 2_000_000,
	receivedQuantity: null,
	missingQuantity: null,
	...over,
})

const transfer = (over: Record<string, unknown> = {}) => ({
	id: 'trf_in',
	number: 7,
	kind: 'transfer',
	status: 'sent',
	fromLocationId: 'central',
	toLocationId: 'main',
	lineCount: 1,
	note: null,
	createdAt: 1,
	sentAt: 2,
	receivedAt: null,
	missingLines: 0,
	version: 3,
	lines: [line()],
	...over,
})

let page: Page
const manager = (): Session => session({ role: 'manager' })

beforeEach(async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {})
	installDom()
	await resetStock()
	page = mount()
	fixture.settings.transfersEnabled = true
	fixture.transfers = [
		transfer(),
		transfer({
			id: 'trf_done',
			number: 6,
			status: 'received',
			receivedAt: 5,
			lines: [
				line({
					sentQuantity: 2_000_000,
					receivedQuantity: 1_500_000,
					missingQuantity: 500_000,
				}),
			],
		}),
	]
	fixture.transferItems = [
		{
			id: 'item_tomato',
			name: 'Tomatoes',
			kind: 'bought',
			baseUnit: 'g',
			countUnit: 'kg',
			units: [],
		},
		{
			id: 'item_secret',
			name: 'Secret spice',
			kind: 'bought',
			baseUnit: 'g',
			countUnit: 'kg',
			units: [],
		},
	]
	fixture.transferBlocked = [
		{ fromLocationId: 'central', itemIds: ['item_secret'] },
	]
	usePos.setState({
		snapshot: {
			menu: {
				locations: [
					{ id: 'main', name: 'Downtown' },
					{ id: 'central', name: 'Central kitchen' },
				],
			},
		},
	} as never)
})
afterEach(async () => {
	await page.unmount()
	await resetStock()
	delete fixture.settings.transfersEnabled
	delete fixture.transfers
	delete fixture.transferItems
	delete fixture.transferBlocked
	usePos.setState({ snapshot: null } as never)
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

async function openStock(node: { online?: boolean; session?: Session } = {}) {
	const props = {
		settings,
		session: node.session ?? manager(),
		online: node.online ?? true,
		onSignIn: vi.fn(),
	}
	await page.draw(h(Stock, props))
	return props
}
const loaded = () =>
	vi.waitFor(() => expect(text(page.host)).toContain('Weekly count'))
const dialog = () => page.host.querySelector('dialog[open]')!

describe('Transfers (#515)', () => {
	it('has a Transfers tile only while the transfers flag is on', async () => {
		delete fixture.settings.transfersEnabled
		region().install()
		await openStock()
		await loaded()
		expect(hasButton(page.host, /^Transfers/)).toBe(false)
	})

	it('lists what is on its way in and what arrived short, with quantities only', async () => {
		region().install()
		await openStock()
		await loaded()
		await click(button(page.host, /^Transfers/))
		const sheet = dialog()
		expect(text(sheet)).toContain('On the way in')
		expect(text(sheet)).toContain('From Central kitchen')
		expect(text(sheet)).toContain('Tomatoes · 2 kg')
		// A line that arrived short shows as missing in transit.
		expect(
			sheet.querySelector('[data-testid="transfer-missing-trf_done"]')
				?.textContent,
		).toContain('Tomatoes 0.5 kg')
		expect(text(sheet)).not.toMatch(/[$€£]|price|cost|value/i)
	})

	it('receives a transfer offline, ticking what arrived, and sends the receipt with the version it read when back online', async () => {
		const online = region()
		online.install()
		await openStock()
		await loaded()
		await page.unmount()
		page = mount()
		// No connection: the lists come from the tablet and the receipt waits in the queue.
		const offline = region({ online: false })
		offline.install()
		const props = await openStock({ online: false })
		await loaded()
		await click(button(page.host, /^Transfers/))
		await click(button(dialog(), 'Receive'))
		await vi.waitFor(() =>
			expect(
				dialog().querySelector('[data-testid="transfer-step-receive"]'),
			).not.toBeNull(),
		)
		// 1 kg of the 2 kg tomatoes arrived.
		await click(button(dialog(), 'One less Tomatoes'))
		await click(button(dialog(), 'Confirm received'))
		let rows: Awaited<ReturnType<typeof stockRows>> = []
		await vi.waitFor(async () => {
			rows = await stockRows(ORIGIN)
			expect(rows).toHaveLength(1)
		})
		expect(rows[0]).toMatchObject({
			kind: 'transfer_receive',
			madeBy: 'stf_ana',
			payload: {
				transferId: 'trf_in',
				expectedVersion: 3,
				lines: [{ itemId: 'item_tomato', amount: 1, unit: 'kg' }],
			},
		})
		expect(offline.writes(/receive$/)).toEqual([])
		await vi.waitFor(() =>
			expect(text(dialog())).toContain(
				'Saved on this tablet. Waiting to send.',
			),
		)

		// The connection is back.
		offline.state.online = true
		await page.draw(h(Stock, { ...props, online: true }))
		await vi.waitFor(() => expect(offline.writes(/receive$/)).toHaveLength(1), {
			timeout: 10_000,
		})
		const sent = offline.writes(/receive$/)[0]!
		expect(sent.path).toBe('/pos/inventory/transfers/trf_in/receive')
		expect(sent.body).toMatchObject({
			locationId: 'main',
			expectedVersion: 3,
			lines: [{ itemId: 'item_tomato', amount: 1, unit: 'kg' }],
		})
		await vi.waitFor(async () => expect(await stockRows(ORIGIN)).toEqual([]))
	})

	it('a cashier cannot send or receive: it asks for a manager', async () => {
		region().install()
		await openStock({ session: session() })
		await loaded()
		await click(button(page.host, /^Transfers/))
		expect(text(dialog())).toContain('A manager must sign in')
		expect((button(dialog(), 'Receive') as HTMLButtonElement).disabled).toBe(
			true,
		)
	})

	it('asks another place for stock, offering only what it gives out, and queues the request without prices', async () => {
		region().install()
		await openStock()
		await loaded()
		await click(button(page.host, /^Transfers/))
		await click(button(dialog(), /^Ask for stock/))
		await click(button(dialog(), 'Central kitchen'))
		// The spice this place keeps off the list for branches is not offered.
		expect(text(dialog())).toContain('Tomatoes')
		expect(text(dialog())).not.toContain('Secret spice')
		await click(button(dialog(), 'Tomatoes'))
		await click(button(dialog(), 'One more Tomatoes'))
		await click(button(dialog(), 'Send request'))
		let rows: Awaited<ReturnType<typeof stockRows>> = []
		await vi.waitFor(async () => {
			rows = await stockRows(ORIGIN)
			expect(rows.length).toBeGreaterThan(0)
		})
		expect(rows[0]).toMatchObject({
			kind: 'transfer_request',
			payload: {
				fromLocationId: 'central',
				lines: [{ itemId: 'item_tomato', amount: 1, unit: 'kg' }],
			},
		})
		expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/price|cost|value/i)
	})
})
