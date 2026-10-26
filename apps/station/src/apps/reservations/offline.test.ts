// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Connection } from './connection.ts'
import { tableState } from './feed.ts'

import { OfflineStrip } from './OfflineStrip.tsx'
import { PartySheet } from './PartySheet.tsx'
import { StandDock, StandHeader } from './StandHeader.tsx'
import { TableSheet } from './TableSheet.tsx'
import { at, day, rsv } from './testing.ts'
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
const NOW = at(13 * 60 + 31)
let host: HTMLDivElement
let root: Root
beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function showModal() {
		this.setAttribute('open', '')
	}
	HTMLDialogElement.prototype.close = function close() {
		this.removeAttribute('open')
	}
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({ matches: false })),
	)
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	vi.unstubAllGlobals()
})
const render = (node: ReactElement) =>
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, node)))
const formatTime = (ms: number) =>
	new Intl.DateTimeFormat('en', {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: 'UTC',
	}).format(ms)
const REASON = 'Offline: this waits for the connection.'

describe('the strip across the book', () => {
	const strip = (connection: Connection) => {
		render(h(OfflineStrip, { connection, formatTime }))
		return host.querySelector('[role="status"]')
	}
	it('says nothing while the book can be trusted', () => {
		expect(strip({ kind: 'ok' })).toBeNull()
	})
	it('says offline, when the book was last read, and what waits', () => {
		expect(
			strip({ kind: 'offline', readAt: NOW, blocksWrites: true })!.textContent,
		).toBe(
			'Offline: book as of 1:31 PM. Seating, booking and texts wait for the connection.',
		)
	})
	it('says not connected after a failed look, and that it is trying again', () => {
		expect(
			strip({ kind: 'stale', readAt: NOW, blocksWrites: true })!.textContent,
		).toBe(
			'Not connected: book as of 1:31 PM. Seating, booking and texts wait for the connection. Trying again.',
		)
	})
	it('says only the waitlist is behind when the day loaded', () => {
		expect(
			strip({ kind: 'stale', readAt: NOW, blocksWrites: false })!.textContent,
		).toBe('The waitlist is not up to date (as of 1:31 PM). Trying again.')
	})
	it('does not invent a time it was never read', () => {
		expect(
			strip({ kind: 'offline', readAt: null, blocksWrites: true })!.textContent,
		).toContain('this book may be out of date')
	})
})

describe('the adds while offline', () => {
	const header = (offlineReason: string | null) => {
		const props = {
			onWalkIn: vi.fn(),
			onWaitlist: vi.fn(),
			onBooking: vi.fn(),
		}
		render(
			h(StandHeader, {
				totals: { parties: 1, covers: 2, toSeat: 1, seated: 0 },
				filtered: false,
				date: '2026-03-02',
				isToday: true,
				today: '2026-03-02',
				onDate: vi.fn(),
				services: [],
				serviceId: null,
				onService: vi.fn(),
				wide: true,
				waitlistOn: true,
				stale: false,
				offlineReason,
				...props,
			}),
		)
		return props
	}
	const button = (name: RegExp) =>
		[...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
			name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
		)!
	it('are unavailable, with the reason, and do nothing', () => {
		const props = header(REASON)
		for (const [name, fn] of [
			[/Walk-in/, props.onWalkIn],
			[/Add to the waitlist/, props.onWaitlist],
			[/New booking/, props.onBooking],
		] as const) {
			const b = button(name)
			expect(b.getAttribute('aria-disabled')).toBe('true')
			expect(b.title).toBe(REASON)
			act(() => b.click())
			expect(fn).not.toHaveBeenCalled()
		}
	})
	it('work as usual online', () => {
		const props = header(null)
		for (const [name, fn] of [
			[/Walk-in/, props.onWalkIn],
			[/Add to the waitlist/, props.onWaitlist],
			[/New booking/, props.onBooking],
		] as const) {
			expect(button(name).getAttribute('aria-disabled')).toBeNull()
			act(() => button(name).click())
			expect(fn).toHaveBeenCalledTimes(1)
		}
	})
	it('are unavailable on a phone’s dock too', () => {
		const onBooking = vi.fn()
		render(
			h(StandDock, {
				isToday: true,
				waitlistOn: true,
				onWalkIn: vi.fn(),
				onWaitlist: vi.fn(),
				onBooking,
				offlineReason: REASON,
			}),
		)
		const book = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
			(b) => b.getAttribute('aria-label') === 'New booking',
		)!
		expect(book.getAttribute('aria-disabled')).toBe('true')
		act(() => book.click())
		expect(onBooking).not.toHaveBeenCalled()
	})
})

describe('the sheets while offline', () => {
	it('says why the party’s actions are unavailable', () => {
		render(
			h(PartySheet, {
				reservation: rsv({
					start: 13 * 60 + 40,
					guest: { id: 'g', name: 'Rana K', firstName: 'Rana', lastName: 'K' },
				}),
				canReadGuest: true,
				busy: true,
				now: NOW,
				formatTime,
				formatDay: formatTime,
				onCommand: vi.fn(),
				onClose: vi.fn(),
				offlineReason: REASON,
			}),
		)
		const dialog = host.querySelector('dialog')!
		expect(dialog.querySelector('[role="note"]')!.textContent).toBe(REASON)
		const seat = [...dialog.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Choose a table'),
		)!
		expect(seat.disabled).toBe(true)
	})
	it('says why a table’s walk-in is unavailable', () => {
		const feed = day([])
		const table = feed.tables.find((t) => t.id === 't2')!
		render(
			h(TableSheet, {
				target: { table, state: tableState(table, feed, NOW) },
				busy: true,
				now: NOW,
				formatTime,
				onWalkIn: vi.fn(),
				onSeatHeld: vi.fn(),
				onFinish: vi.fn(),
				onDetails: vi.fn(),
				onClose: vi.fn(),
				offlineReason: REASON,
			}),
		)
		expect(host.querySelector('dialog [role="note"]')!.textContent).toBe(REASON)
	})
})
