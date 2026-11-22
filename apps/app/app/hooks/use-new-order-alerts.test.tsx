// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Order } from '#app/utils/orders/order-model.ts'

const sound = vi.hoisted(() => ({
	prefs: {
		enabled: true,
		volume: 0.8,
		sound: 'chime' as const,
		promptAnswered: true,
	},
	state: 'running' as 'running' | 'blocked' | 'unsupported',
	playChime: vi.fn(),
	playSample: vi.fn(() => true),
	unlockChime: vi.fn(),
}))

vi.mock('#app/utils/orders/waiting-chime.ts', () => ({
	chimePlayer: {
		state: () => sound.state,
		ready: () => sound.state === 'running',
	},
	playChime: sound.playChime,
	playSample: sound.playSample,
	unlockChime: sound.unlockChime,
	readSoundPrefs: () => ({ ...sound.prefs }),
	writeSoundPrefs: (patch: Record<string, unknown>) => {
		sound.prefs = { ...sound.prefs, ...patch } as typeof sound.prefs
		return { ...sound.prefs }
	},
}))

import { useNewOrderAlerts } from './use-new-order-alerts.ts'

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)
const MIN = 60_000

function order(over: Partial<Order> = {}): Order {
	return {
		id: 'o1',
		number: 'W-0042',
		status: 'accepted',
		paymentStatus: 'unpaid',
		paymentMethod: 'handoff',
		loyaltyDiscountCents: 0,
		totalCents: 3850,
		refundedCents: 0,
		currency: 'SAR',
		createdAt: null,
		contact: { name: 'Layla Hassan', phone: '+966501234567', email: null },
		fulfillment: 'pickup',
		location: { id: 'loc', name: 'Downtown' },
		lines: [],
		pickup: null,
		drop: null,
		delivery: null,
		timeZone: 'Asia/Riyadh',
		...over,
	} as Order
}

function mount(initial: Order[], loading = false) {
	return renderHook(
		({ orders, isLoading }) =>
			useNewOrderAlerts({ orders, loading: isLoading, locale: 'en' }),
		{ initialProps: { orders: initial, isLoading: loading } },
	)
}

type Mounted = ReturnType<typeof mount>

// Re-renders the hook with a new order list (wrapped in act by the caller).
function pushProps(
	hook: Mounted,
	props: { orders: Order[]; isLoading: boolean },
) {
	hook.rerender(props)
}

describe('useNewOrderAlerts (#265)', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		sound.playChime.mockClear()
		sound.playSample.mockClear()
		sound.prefs = {
			enabled: true,
			volume: 0.8,
			sound: 'chime',
			promptAnswered: true,
		}
		sound.state = 'running'
		document.title = 'Orders'
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it('chimes and shows an alert within one refresh of a new order, and says nothing of the guest', () => {
		const hook = mount([])
		expect(sound.playChime).not.toHaveBeenCalled()
		act(() => {
			pushProps(hook, { orders: [order()], isLoading: false })
		})
		expect(sound.playChime).toHaveBeenCalledTimes(1)
		expect(hook.result.current.items).toHaveLength(1)
		expect(hook.result.current.activeCount).toBe(1)
		expect(document.title).toBe('(1) Orders')
		expect(JSON.stringify(hook.result.current.items)).not.toContain('Layla')
	})

	it('does not alert for orders that were already there when the page opened', () => {
		const hook = mount([order()])
		act(() => {
			pushProps(hook, { orders: [order()], isLoading: false })
		})
		expect(sound.playChime).not.toHaveBeenCalled()
		expect(hook.result.current.items).toHaveLength(0)
	})

	it('repeats every 30 seconds until the order is opened', () => {
		const hook = mount([])
		act(() => pushProps(hook, { orders: [order()], isLoading: false }))
		expect(sound.playChime).toHaveBeenCalledTimes(1)
		act(() => {
			vi.advanceTimersByTime(30_000)
		})
		expect(sound.playChime).toHaveBeenCalledTimes(2)
		act(() => {
			vi.advanceTimersByTime(30_000)
		})
		expect(sound.playChime).toHaveBeenCalledTimes(3)
		act(() => hook.result.current.dismiss('o1'))
		act(() => {
			vi.advanceTimersByTime(120_000)
		})
		expect(sound.playChime).toHaveBeenCalledTimes(3)
		expect(document.title).toBe('Orders')
	})

	it('stops repeating once the order is accepted or started', () => {
		const hook = mount([])
		act(() => pushProps(hook, { orders: [order()], isLoading: false }))
		act(() =>
			pushProps(hook, {
				orders: [order({ status: 'preparing' })],
				isLoading: false,
			}),
		)
		act(() => {
			vi.advanceTimersByTime(90_000)
		})
		expect(sound.playChime).toHaveBeenCalledTimes(1)
		expect(hook.result.current.items).toHaveLength(0)
	})

	it('leaves the chime for an order waiting for acceptance to the "Waiting for you" lane', () => {
		const hook = mount([])
		act(() =>
			pushProps(hook, {
				orders: [order({ status: 'pending_acceptance' })],
				isLoading: false,
			}),
		)
		expect(hook.result.current.items).toHaveLength(1)
		act(() => {
			vi.advanceTimersByTime(60_000)
		})
		expect(sound.playChime).not.toHaveBeenCalled()
	})

	it('is quiet while the member has the sound off, but still shows the alert', () => {
		sound.prefs.enabled = false
		const hook = mount([])
		act(() => pushProps(hook, { orders: [order()], isLoading: false }))
		act(() => {
			vi.advanceTimersByTime(60_000)
		})
		expect(sound.playChime).not.toHaveBeenCalled()
		expect(hook.result.current.items).toHaveLength(1)
	})

	it('tells a scheduled order softly once, then loudly at its time', () => {
		const hook = mount([])
		const later = order({
			scheduledFor: new Date(NOW + 10 * MIN).toISOString(),
		})
		act(() => pushProps(hook, { orders: [later], isLoading: false }))
		expect(sound.playChime).toHaveBeenCalledTimes(1)
		expect(sound.playChime).toHaveBeenLastCalledWith({ soft: true })
		expect(hook.result.current.activeCount).toBe(0)
		act(() => {
			vi.advanceTimersByTime(9 * MIN)
		})
		expect(sound.playChime).toHaveBeenCalledTimes(1)
		act(() => {
			vi.advanceTimersByTime(2 * MIN)
		})
		expect(sound.playChime).toHaveBeenCalledTimes(2)
		expect(sound.playChime).toHaveBeenLastCalledWith()
		expect(hook.result.current.activeCount).toBe(1)
	})

	it('shows a desktop notification when the tab is in the background and permission is granted', () => {
		const shown: Array<{ title: string; options: NotificationOptions }> = []
		class FakeNotification {
			static permission: NotificationPermission = 'granted'
			static requestPermission = vi.fn(async () => 'granted' as const)
			constructor(title: string, options: NotificationOptions) {
				shown.push({ title, options })
			}
		}
		vi.stubGlobal('Notification', FakeNotification)
		Object.defineProperty(document, 'visibilityState', {
			value: 'hidden',
			configurable: true,
		})
		const hook = mount([])
		act(() =>
			pushProps(hook, {
				orders: [
					order({
						largeOrder: true,
						contact: {
							name: 'Layla Hassan',
							phone: '+966501234567',
							email: 'layla@example.com',
						},
					}),
				],
				isLoading: false,
			}),
		)
		expect(shown).toHaveLength(1)
		expect(shown[0]!.title).toBe('New order W-0042')
		expect(shown[0]!.options.body).toContain('Large order')
		const all = JSON.stringify(shown)
		for (const guest of ['Layla', '+9665', 'example.com'])
			expect(all).not.toContain(guest)
		Object.defineProperty(document, 'visibilityState', {
			value: 'visible',
			configurable: true,
		})
	})

	it('shows no desktop notification while the tab is visible, or without permission', () => {
		const shown: string[] = []
		class FakeNotification {
			static permission: NotificationPermission = 'granted'
			static requestPermission = vi.fn(async () => 'granted' as const)
			constructor(title: string) {
				shown.push(title)
			}
		}
		vi.stubGlobal('Notification', FakeNotification)
		const hook = mount([])
		act(() => pushProps(hook, { orders: [order()], isLoading: false }))
		expect(shown).toHaveLength(0)
	})

	it('says the browser is blocking sound until it is allowed', () => {
		sound.state = 'blocked'
		const hook = mount([])
		expect(hook.result.current.soundBlocked).toBe(true)
		sound.state = 'running'
		act(() => {
			vi.advanceTimersByTime(5_000)
		})
		expect(hook.result.current.soundBlocked).toBe(false)
	})

	it('remembers the sound, the volume and on or off through the bell', () => {
		const hook = mount([])
		act(() =>
			hook.result.current.setPrefs({
				sound: 'bell',
				volume: 0.4,
				enabled: false,
			}),
		)
		expect(hook.result.current.prefs).toMatchObject({
			sound: 'bell',
			volume: 0.4,
			enabled: false,
		})
		act(() => {
			hook.result.current.test()
		})
		expect(sound.unlockChime).toHaveBeenCalled()
		expect(sound.playSample).toHaveBeenCalledWith('bell', 0.4)
	})
})
