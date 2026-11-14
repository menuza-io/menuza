// @vitest-environment jsdom
/* eslint-disable testing-library/no-unnecessary-act -- a hook driven without Testing Library */
import { type PosOnlineOrdersFeed } from '@repo/common/pos-online-orders'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrdersError } from './api.ts'
import { useOrders, type OrdersState } from './useOrders.ts'
import { loadSettings } from '~/lib/config.ts'

const api = vi.hoisted(() => ({
	feed: vi.fn(),
	detail: vi.fn(),
	command: vi.fn(),
	refund: vi.fn(),
	contact: vi.fn(),
}))
vi.mock('./demo.ts', () => ({ demoOrders: () => api }))
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const feed: PosOnlineOrdersFeed = {
	orders: [],
	phonePickups: [],
	grants: {
		view: true,
		manage: true,
		contact: true,
		cancel: true,
		refund: true,
	},
	serverNow: Date.now(),
	truncated: false,
}
let host: HTMLDivElement
let root: Root
let state: OrdersState
const settings = { ...loadSettings(), demo: true }
function Probe() {
	state = useOrders(settings, null, true)
	return null
}
const flush = () => act(async () => {})

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset()
	api.feed.mockResolvedValue(feed)
	host = document.createElement('div')
	root = createRoot(host)
	await act(async () => root.render(h(Probe)))
})
afterEach(() => {
	act(() => root.unmount())
})

describe('useOrders', () => {
	it('keeps alerting for an order whose opening the server did not record', async () => {
		api.command.mockRejectedValue(new OrdersError('connection_lost'))
		api.detail.mockRejectedValue(new OrdersError('connection_lost'))
		await act(async () => state.open('o1'))
		await flush()
		expect(state.openedHere.has('o1')).toBe(false)
		expect(state.actionError?.code).toBe('connection_lost')
	})

	it('closes the open order when the staff session ends, so sign-in is reachable', async () => {
		api.command.mockResolvedValue({
			order: { id: 'o1' },
			grants: feed.grants,
			serverNow: Date.now(),
		})
		await act(async () => state.open('o1'))
		expect(state.selected).toBe('o1')
		api.feed.mockRejectedValue(new OrdersError('staff_session_invalid', 401))
		await act(async () => state.refresh())
		expect(state.selected).toBeNull()
		expect(state.error?.code).toBe('staff_session_invalid')
	})

	it('sends one contact request for a double tap', async () => {
		api.command.mockResolvedValue({
			order: { id: 'o1' },
			grants: feed.grants,
			serverNow: Date.now(),
		})
		let answer: (value: unknown) => void = () => {}
		api.contact.mockReturnValue(new Promise((resolve) => (answer = resolve)))
		await act(async () => state.open('o1'))
		await act(async () => {
			void state.revealContact()
			void state.revealContact()
		})
		expect(api.contact).toHaveBeenCalledTimes(1)
		await act(async () => answer({ phone: '+1', email: null }))
		expect(state.contact).toEqual({ phone: '+1', email: null })
	})
	describe('a failed write', () => {
		const opened = { order: { id: 'o1' }, grants: feed.grants, serverNow: 1 }
		const version = 'a'.repeat(64)
		async function failAccept() {
			api.command.mockResolvedValueOnce(opened)
			await act(async () => state.open('o1'))
			api.command.mockRejectedValueOnce(new OrdersError('stale_version', 409))
			api.detail.mockResolvedValue(opened)
			await act(async () => {
				await state.command({ action: 'accept', expectedVersion: version })
			})
		}

		it('records which command failed, and forgets it when the error goes', async () => {
			await failAccept()
			expect(state.actionError?.code).toBe('stale_version')
			expect(state.actionName).toBe('accept')
			act(() => state.close())
			expect(state.actionError).toBeNull()
			expect(state.actionName).toBeNull()
		})

		it('clears its error after 8 s, but not while a dialog shows it', async () => {
			vi.useFakeTimers()
			try {
				await failAccept()
				act(() => state.pinActionError(true))
				await act(async () => vi.advanceTimersByTime(20_000))
				expect(state.actionError?.code).toBe('stale_version')
				act(() => state.pinActionError(false))
				await act(async () => vi.advanceTimersByTime(8_100))
				expect(state.actionError).toBeNull()
			} finally {
				vi.useRealTimers()
			}
		})
	})
})
