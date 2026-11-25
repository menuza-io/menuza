// @vitest-environment jsdom
/* eslint-disable testing-library/no-unnecessary-act */
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	type DeliveryBoard,
	type DeliveryRunView,
	type DeliveryStopView,
} from '@repo/common/delivery-runs'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliveriesError, type DeliveriesApi, type DeliveriesMe } from './api.ts'
import { Deliveries } from './Deliveries.tsx'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Station's Deliveries app (#287): a manager's board, a driver's own run, and
 * what everyone else sees. The region answers each read; the screen holds no
 * address of its own.
 */

const stop = (values: Partial<DeliveryStopView> = {}): DeliveryStopView => ({
	id: 'st1',
	orderId: 'o1',
	number: 'D-1',
	stopNo: 1,
	status: 'pending',
	problemKind: null,
	firstName: 'Layla',
	address: '233 South Wacker Drive',
	unit: 'Suite 4',
	notes: 'Front desk',
	mapUrl: 'https://www.google.com/maps/search/?api=1&query=233',
	cashDueCents: 0,
	cashCollectedCents: 0,
	tipCents: 0,
	currency: 'USD',
	canCall: false,
	...values,
})
const run = (stops: DeliveryStopView[], values: Partial<DeliveryRunView> = {}): DeliveryRunView => ({
	id: 'r1',
	status: 'assigned',
	locationId: 'loc',
	driver: { staffId: 's-ana', name: 'Ana D.' },
	createdByKind: 'manager',
	createdAt: 1,
	pickedUpAt: null,
	stops,
	position: null,
	...values,
})
const driverMe = (values: Partial<DeliveriesMe> = {}): DeliveriesMe => ({
	role: 'driver',
	isDriver: true,
	unavailable: false,
	claimable: [],
	run: null,
	notices: [],
	...values,
})

const settings = { demo: false } as PosSettings
const session = { serverSession: { token: 't' } } as Session

let host: HTMLDivElement
let root: Root
let me: DeliveriesMe
let board: DeliveryBoard
let api: { [K in keyof DeliveriesApi]: ReturnType<typeof vi.fn> }

beforeEach(() => {
	i18n.loadAndActivate({ locale: 'en', messages: {} })
	board = { locationId: 'loc', unassigned: [], runs: [], drivers: [] }
	me = driverMe()
	api = {
		me: vi.fn(async () => me),
		board: vi.fn(async () => board),
		assign: vi.fn(async () => undefined),
		claim: vi.fn(async () => undefined),
		reassign: vi.fn(async () => undefined),
		pickUp: vi.fn(async () => undefined),
		delivered: vi.fn(async () => undefined),
		problem: vi.fn(async () => undefined),
		release: vi.fn(async () => undefined),
		callGuest: vi.fn(async () => undefined),
		driverAvailability: vi.fn(async () => undefined),
		myAvailability: vi.fn(async () => undefined),
		sharePosition: vi.fn(async () => undefined),
		stopSharing: vi.fn(async () => undefined),
	}
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
})
afterEach(async () => {
	await act(async () => root.unmount())
	host.remove()
})

async function mount(sessionValue: Session | null = session) {
	await act(async () => {
		root.render(
			h(
				I18nProvider,
				{ i18n },
				h(Deliveries, {
					settings,
					session: sessionValue,
					online: true,
					onSignIn: vi.fn(),
					api: api as unknown as DeliveriesApi,
				}),
			),
		)
	})
	// The first read.
	await act(async () => {
		await Promise.resolve()
	})
}
const text = () => host.textContent ?? ''
const click = async (label: string | RegExp) => {
	const button = [...host.querySelectorAll('button, a')].find((node) =>
		typeof label === 'string' ? node.textContent?.trim() === label : label.test(node.textContent ?? ''),
	) as HTMLElement | undefined
	expect(button, `button ${String(label)}`).toBeTruthy()
	await act(async () => {
		button!.click()
		await Promise.resolve()
	})
}

describe('Deliveries on Station (#287)', () => {
	it('asks to sign in before showing anything', async () => {
		await mount(null)
		expect(text()).toContain('Sign in with your PIN')
		expect(api.me).not.toHaveBeenCalled()
	})

	it('gives a person who is neither manager nor driver a plain explanation and no data', async () => {
		me = driverMe({ role: 'none', isDriver: false })
		await mount()
		expect(text()).toContain('Deliveries are for managers and drivers')
		expect(api.board).not.toHaveBeenCalled()
	})

	describe('driver', () => {
		it('shows only their own run: first name, address, notes, cash to collect and a map link', async () => {
			me = driverMe({
				run: run([stop({ cashDueCents: 2500, tipCents: 300, canCall: true })]),
			})
			await mount()
			const t = text()
			expect(t).toContain('D-1 · Layla')
			expect(t).toContain('233 South Wacker Drive · Suite 4')
			expect(t).toContain('Front desk')
			expect(t).toContain('Collect cash: $25.00')
			expect(t).toContain('Tip: $3.00')
			expect(host.querySelector('a[href^="https://www.google.com/maps"]')).toBeTruthy()
			expect(t).toContain('Call guest')
			// A driver never sees the board.
			expect(api.board).not.toHaveBeenCalled()
			expect(t).not.toContain('Ready for a driver')
		})

		it('marks everything picked up at once, then delivered', async () => {
			me = driverMe({ run: run([stop(), stop({ id: 'st2', number: 'D-2', stopNo: 2 })]) })
			await mount()
			await click('Picked up')
			expect(api.pickUp).toHaveBeenCalledWith('r1')
			me = driverMe({
				run: run([stop({ status: 'picked_up' }), stop({ id: 'st2', number: 'D-2', stopNo: 2, status: 'picked_up' })], {
					status: 'on_the_road',
				}),
			})
			await act(async () => {
				;(host.querySelector('button') as HTMLElement).click()
				await Promise.resolve()
			})
			const delivered = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Delivered')
			expect(delivered).toHaveLength(2)
			await act(async () => {
				delivered[0]!.click()
				await Promise.resolve()
			})
			expect(api.delivered).toHaveBeenCalledWith('st1')
		})

		it('asks how much cash was collected when the guest paid on delivery', async () => {
			me = driverMe({ run: run([stop({ status: 'picked_up', cashDueCents: 2500 })], { status: 'on_the_road' }) })
			await mount()
			await click('Delivered')
			expect(api.delivered).not.toHaveBeenCalled()
			const input = host.querySelector('input[inputmode="decimal"]') as HTMLInputElement
			expect(input.placeholder).toBe('25.00')
			await click('Confirm delivered')
			// Left empty: the amount that was due.
			expect(api.delivered).toHaveBeenCalledWith('st1', 2500)
		})

		it('reports a problem with a reason', async () => {
			me = driverMe({ run: run([stop({ status: 'picked_up' })], { status: 'on_the_road' }) })
			await mount()
			await click('Problem')
			await click('Nobody home')
			expect(api.problem).toHaveBeenCalledWith('st1', 'not_home')
		})

		it('lets a driver with no run take ready orders, or step out', async () => {
			me = driverMe({
				claimable: [
					{
						id: 'o9',
						number: 'D-9',
						firstName: 'Omar',
						address: '1 Other Street',
						unit: null,
						zoneName: null,
						promisedAt: null,
						readyAt: null,
						cashDueCents: 0,
						tipCents: 0,
						currency: 'USD',
					},
				],
			})
			await mount()
			expect(text()).toContain('You have no run right now')
			const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement
			await act(async () => box.click())
			await click('Take these deliveries')
			expect(api.claim).toHaveBeenCalledWith(['o9'])
			await click('Set myself unavailable')
			expect(api.myAvailability).toHaveBeenCalledWith(true)
		})

		it('shows what a manager changed, once, until the driver closes it', async () => {
			me = driverMe({
				notices: [{ id: 'n1', kind: 'taken_away', orderNumbers: ['D-1', 'D-2'], createdAt: 1 }],
			})
			await mount()
			expect(text()).toContain('A manager gave your run to someone else: D-1, D-2')
			await click('Got it')
			expect(text()).not.toContain('gave your run')
		})

		it('says nothing about a finished run: no address is left on screen', async () => {
			me = driverMe({ run: null })
			await mount()
			expect(text()).not.toContain('233 South Wacker')
			expect(text()).toContain('You have no run right now')
		})

		it('says what went wrong, in words, and reads the run again', async () => {
			me = driverMe({ run: run([stop({ status: 'picked_up' })], { status: 'on_the_road' }) })
			api.delivered.mockRejectedValue(new DeliveriesError('stop_not_found', 404))
			await mount()
			const reads = api.me.mock.calls.length
			await click('Delivered')
			expect(text()).toContain('That delivery is no longer on your list.')
			expect(api.me.mock.calls.length).toBeGreaterThan(reads)
		})
	})

	describe('manager', () => {
		beforeEach(() => {
			me = driverMe({ role: 'manager', isDriver: false })
			board = {
				locationId: 'loc',
				unassigned: [
					{
						id: 'o1',
						number: 'D-1',
						firstName: 'Layla',
						address: '233 South Wacker Drive',
						unit: null,
						zoneName: null,
						promisedAt: null,
						readyAt: null,
						cashDueCents: 0,
						tipCents: 0,
						currency: 'USD',
					},
				],
				runs: [run([stop({ status: 'picked_up' })], { status: 'on_the_road' })],
				drivers: [
					{ staffId: 's-ana', name: 'Ana D.', unavailable: false, openRuns: 1 },
					{ staffId: 's-ben', name: 'Ben D.', unavailable: false, openRuns: 0 },
				],
			}
		})

		it('shows ready orders, runs and drivers', async () => {
			await mount()
			expect(api.board).toHaveBeenCalled()
			expect(text()).toContain('Ready for a driver')
			expect(text()).toContain('D-1 · Layla')
			expect(text()).toContain('Ana D.')
			expect(text()).toContain('On the road')
		})

		it('assigns the picked order to the chosen driver', async () => {
			await mount()
			const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement
			await act(async () => box.click())
			const select = [...host.querySelectorAll('select')].find((s) => s.textContent?.includes('Choose a driver'))!
			await act(async () => {
				const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
				setter.call(select, 's-ben')
				select.dispatchEvent(new Event('change', { bubbles: true }))
			})
			await click('Assign as one run')
			expect(api.assign).toHaveBeenCalledWith('s-ben', ['o1'])
		})

		it('marks a stop delivered on the driver\'s behalf, takes it back and sets a driver unavailable', async () => {
			await mount()
			await click('Mark delivered')
			expect(api.delivered).toHaveBeenCalledWith('st1')
			await click('Take back')
			expect(api.release).toHaveBeenCalledWith('st1')
			await act(async () => {
				;[...host.querySelectorAll('button')].filter((b) => b.textContent === 'Set unavailable')[1]!.click()
				await Promise.resolve()
			})
			expect(api.driverAvailability).toHaveBeenCalledWith('s-ben', true)
		})
	})
})
