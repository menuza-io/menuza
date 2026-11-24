/* eslint-disable testing-library/no-unnecessary-act */
// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AfterPunch, MY_WEEK_SECONDS } from './AfterPunch.tsx'
import { type stationClockApi } from './clock.ts'
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

type Api = ReturnType<typeof stationClockApi>

const NOW = Date.UTC(2026, 2, 4, 18, 0, 0)

const announcement = (id: string, readAt: number | null = null) => ({
	id,
	title: `Title ${id}`,
	body: `Body ${id}`,
	expiresAt: NOW + 86_400_000,
	createdAt: NOW - 1000,
	readAt,
})

const week = (pay?: boolean) => ({
	firstName: 'Rana',
	week: {
		serverNow: NOW,
		weekStart: '2026-03-02',
		weekEnd: '2026-03-08',
		timeZone: 'America/Chicago',
		workedMinutes: 14 * 60,
		scheduledMinutes: 32 * 60,
		nextShift: {
			startsAt: NOW + 3_600_000,
			endsAt: NOW + 7 * 3_600_000,
			timeZone: 'America/Chicago',
		},
		...(pay
			? {
					pay: {
						label: 'estimate_before_tax' as const,
						periodStart: '2026-03-02',
						periodEnd: '2026-03-15',
						estimateMinor: 28000,
						currency: 'USD',
						overtimeMinutes: 0,
					},
				}
			: {}),
	},
})

function fakeApi(overrides: Partial<Api> = {}) {
	const api = {
		announcements: vi.fn(async () => ({
			serverNow: NOW,
			announcements: [announcement('a1')],
		})),
		readAnnouncement: vi.fn(async () => ({ readAt: NOW })),
		myWeek: vi.fn(async () => week(false)),
		...overrides,
	}
	return api as unknown as Api & typeof api
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
	vi.useFakeTimers({
		toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
	})
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	vi.useRealTimers()
})

async function flush() {
	await act(async () => {
		await Promise.resolve()
		await Promise.resolve()
	})
}

function mount(
	api: Api,
	extra: { onHold?: (hold: boolean) => void; onFinish?: () => void } = {},
) {
	const onHold = extra.onHold ?? vi.fn()
	const onFinish = extra.onFinish ?? vi.fn()
	act(() => {
		root.render(
			h(
				I18nProvider,
				{ i18n },
				h(AfterPunch, {
					api,
					pin: '1234',
					touched: 0,
					timeZone: 'America/Chicago',
					onHold,
					onFinish,
				}),
			),
		)
	})
	return { onHold, onFinish }
}

const buttons = () => [...host.querySelectorAll('button')]
const button = (name: string) =>
	buttons().find((b) => b.textContent?.trim() === name)!

describe('after a punch: announcements (#486)', () => {
	it('shows what is unread and records "Got it" with the PIN just used', async () => {
		const api = fakeApi()
		mount(api)
		await flush()
		expect(api.announcements).toHaveBeenCalledWith('1234')
		const cards = host.querySelectorAll('[data-testid="station-announcement"]')
		expect(cards).toHaveLength(1)
		expect(cards[0]!.textContent).toContain('Title a1')
		expect(cards[0]!.textContent).toContain('Body a1')
		await act(async () => {
			button('Got it').click()
			await Promise.resolve()
		})
		await flush()
		expect(api.readAnnouncement).toHaveBeenCalledWith('1234', 'a1')
		// Read: it is gone from the screen.
		expect(
			host.querySelectorAll('[data-testid="station-announcement"]'),
		).toHaveLength(0)
	})

	it('holds the screen only while something is unread', async () => {
		const api = fakeApi()
		const { onHold } = mount(api)
		await flush()
		expect(onHold).toHaveBeenLastCalledWith(true)
		await act(async () => {
			button('Got it').click()
			await Promise.resolve()
		})
		await flush()
		expect(onHold).toHaveBeenLastCalledWith(false)
	})

	it('ends the screen after a minute when nobody touches it', async () => {
		const api = fakeApi()
		const { onFinish } = mount(api)
		await flush()
		expect(onFinish).not.toHaveBeenCalled()
		act(() => {
			vi.advanceTimersByTime(60_000)
		})
		expect(onFinish).toHaveBeenCalledTimes(1)
	})

	it('says nothing when the server cannot answer, and still offers My week', async () => {
		const api = fakeApi({
			announcements: vi.fn(async () => {
				throw new Error('offline')
			}) as never,
		})
		mount(api)
		await flush()
		expect(
			host.querySelectorAll('[data-testid="station-announcement"]'),
		).toHaveLength(0)
		expect(button('My week')).toBeTruthy()
	})
})

describe('after a punch: My week (#514)', () => {
	it('shows hours and the next shift, and no pay unless the server sent it', async () => {
		const api = fakeApi({
			announcements: vi.fn(async () => ({
				serverNow: NOW,
				announcements: [],
			})) as never,
		})
		mount(api)
		await flush()
		await act(async () => {
			button('My week').click()
			await Promise.resolve()
		})
		await flush()
		expect(api.myWeek).toHaveBeenCalledWith('1234')
		const view = host.querySelector('[data-testid="station-my-week"]')!
		expect(view.textContent).toContain('My week, Rana')
		expect(view.textContent).toContain('14 h')
		expect(view.textContent).toContain('32 h')
		expect(host.querySelector('[data-testid="station-pay"]')).toBeNull()
		expect(view.textContent).not.toMatch(/estimate|\$/i)
	})

	it('shows an estimate before tax when the organization turned it on', async () => {
		const api = fakeApi({
			announcements: vi.fn(async () => ({
				serverNow: NOW,
				announcements: [],
			})) as never,
			myWeek: vi.fn(async () => week(true)) as never,
		})
		mount(api)
		await flush()
		await act(async () => {
			button('My week').click()
			await Promise.resolve()
		})
		await flush()
		const pay = host.querySelector('[data-testid="station-pay"]')!
		expect(pay.textContent).toContain('Estimate before tax')
		expect(pay.textContent).toContain('$280.00')
	})

	it('locks after 30 seconds whatever is touched, and drops everything it fetched', async () => {
		const api = fakeApi({
			announcements: vi.fn(async () => ({
				serverNow: NOW,
				announcements: [],
			})) as never,
			myWeek: vi.fn(async () => week(true)) as never,
		})
		const { onFinish, onHold } = mount(api)
		await flush()
		await act(async () => {
			button('My week').click()
			await Promise.resolve()
		})
		await flush()
		expect(host.querySelector('[data-testid="station-my-week"]')).not.toBeNull()
		expect(onHold).toHaveBeenLastCalledWith(true)
		act(() => {
			vi.advanceTimersByTime((MY_WEEK_SECONDS - 1) * 1000)
		})
		expect(host.querySelector('[data-testid="station-my-week"]')).not.toBeNull()
		expect(onFinish).not.toHaveBeenCalled()
		act(() => {
			vi.advanceTimersByTime(1000)
		})
		expect(host.querySelector('[data-testid="station-my-week"]')).toBeNull()
		expect(host.querySelector('[data-testid="station-pay"]')).toBeNull()
		expect(host.textContent).not.toContain('$280.00')
		expect(onFinish).toHaveBeenCalledTimes(1)
	})

	it('closes at once on Close, and says so when it cannot load', async () => {
		const failing = fakeApi({
			announcements: vi.fn(async () => ({
				serverNow: NOW,
				announcements: [],
			})) as never,
			myWeek: vi.fn(async () => {
				throw new Error('offline')
			}) as never,
		})
		mount(failing)
		await flush()
		await act(async () => {
			button('My week').click()
			await Promise.resolve()
		})
		await flush()
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(
			'Could not load your week',
		)

		act(() => root.unmount())
		root = createRoot(host)
		const api = fakeApi({
			announcements: vi.fn(async () => ({
				serverNow: NOW,
				announcements: [],
			})) as never,
		})
		const { onFinish } = mount(api)
		await flush()
		await act(async () => {
			button('My week').click()
			await Promise.resolve()
		})
		await flush()
		act(() => {
			button('Close').click()
		})
		expect(onFinish).toHaveBeenCalledTimes(1)
		expect(host.querySelector('[data-testid="station-my-week"]')).toBeNull()
	})
})
