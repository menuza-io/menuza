// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	DEFAULT_KDS_CONFIG,
	type KdsFeed,
	type KdsTicket,
} from '@repo/common/kds'
import { act, createElement as h, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KitchenError } from './api.ts'
import { Kitchen } from './Kitchen.tsx'
import { useKitchen } from './useKitchen.ts'
import { loadSettings } from '~/lib/config.ts'

vi.mock('./useKitchen.ts', () => ({ useKitchen: vi.fn() }))
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
const NOW = 2_000_000
const ticket: KdsTicket = {
	id: 'ticket',
	source: 'pos',
	number: 'T1-001',
	channel: 'counter',
	fulfillment: 'dine_in',
	tableLabel: '12',
	createdAt: NOW - 21 * 60_000,
	dueAt: null,
	completedAt: null,
	cancelled: false,
	version: 'a'.repeat(64),
	lines: [
		{
			id: 'line',
			itemId: 'dish',
			name: 'House dish',
			quantity: 2,
			variant: 'Regular',
			variantId: null,
			options: [],
			instructions: 'No salt',
			stationId: 'kitchen',
			stage: 'new',
		},
	],
}
let host: HTMLDivElement
let root: Root
const command = vi.fn(async () => true)
const issues: unknown[][] = []
beforeEach(() => {
	localStorage.clear()
	command.mockClear()
	issues.length = 0
	vi.spyOn(console, 'error').mockImplementation((...args) => {
		issues.push(args)
	})
	vi.spyOn(console, 'warn').mockImplementation((...args) => {
		issues.push(args)
	})
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	)
	vi.stubGlobal('matchMedia', () => ({ matches: true }))
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	localStorage.clear()
	try {
		expect(issues).toEqual([])
	} finally {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	}
})
function draw(
	over: Partial<ReturnType<typeof useKitchen>> = {},
	props: Partial<ComponentProps<typeof Kitchen>> = {},
) {
	const feed: KdsFeed = {
		config: DEFAULT_KDS_CONFIG,
		configVersion: 1,
		tickets: [ticket],
		serverNow: NOW,
		truncated: false,
	}
	vi.mocked(useKitchen).mockReturnValue({
		feed,
		error: null,
		busy: false,
		stale: false,
		now: NOW,
		refresh: vi.fn(async () => {}),
		command,
		configure: vi.fn(async () => true),
		...over,
	})
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() =>
		root.render(
			h(
				I18nProvider,
				{ i18n },
				h(Kitchen, {
					settings: {
						...loadSettings(),
						demo: false,
						signInRequired: false,
						slug: 'test',
					},
					session: null,
					online: true,
					categories: [],
					onSignIn: vi.fn(),
					renderHeader: (controls) =>
						h('header', { 'data-test-chrome': true }, controls),
					...props,
				}),
			),
		),
	)
}
describe('flat kitchen presentation retains operational actions', () => {
	it('keeps app-context controls, ticket urgency, shared line composition and bump payload', () => {
		draw()
		expect(
			host.querySelector('header[data-test-chrome] [role="radiogroup"]'),
		).not.toBeNull()
		const article = host.querySelector('article')!
		expect(article.getAttribute('data-age')).toBe('late')
		expect(article.textContent).toContain('No salt')
		expect(article.textContent).toContain('2×')
		expect(article.querySelector('[data-slot="item-content"]')).not.toBeNull()
		const start = [...article.querySelectorAll('button')].find(
			(button) => button.textContent === 'Start preparing',
		)!
		expect(start.dataset.slot).toBe('button')
		act(() => start.click())
		expect(command).toHaveBeenCalledExactlyOnceWith({
			source: 'pos',
			orderId: 'ticket',
			expectedVersion: ticket.version,
			action: 'stage',
			stationId: null,
			lineId: null,
			stage: 'preparing',
		})
	})
	it('keeps stale tickets readable but refuses bumping until reconnected', () => {
		draw({ stale: true })
		expect(host.querySelector('[role="alert"]')!.textContent).toContain(
			'Connection lost.',
		)
		const start = [...host.querySelectorAll('article button')].find(
			(button) => button.textContent === 'Start preparing',
		) as HTMLButtonElement
		expect(start.disabled).toBe(true)
		act(() => start.click())
		expect(command).not.toHaveBeenCalled()
	})
})

describe('new work on the board', () => {
	const feedOf = (tickets: KdsTicket[]): KdsFeed => ({
		config: DEFAULT_KDS_CONFIG,
		configVersion: 1,
		tickets,
		serverNow: NOW,
		truncated: false,
	})
	const fresh = () =>
		[...host.querySelectorAll('article')]
			.filter((article) => article.dataset.fresh === 'true')
			.map((article) => article.getAttribute('aria-label'))

	it('rings a ticket that comes in, and one a table added dishes to, but not the first look', () => {
		draw({ feed: feedOf([ticket]) })
		expect(fresh()).toEqual([])
		const second: KdsTicket = { ...ticket, id: 'second', number: 'T1-002' }
		draw({ feed: feedOf([ticket, second]) })
		expect(fresh()).toEqual(['Ticket T1-002'])
		const added: KdsTicket = {
			...ticket,
			lines: [...ticket.lines, { ...ticket.lines[0]!, id: 'dessert' }],
		}
		draw({ feed: feedOf([added, second]) })
		expect(fresh().sort()).toEqual(['Ticket T1-001', 'Ticket T1-002'])
	})

	it('does not ring a scheduled order the moment it is placed', () => {
		draw({ feed: feedOf([ticket]) })
		const later: KdsTicket = {
			...ticket,
			id: 'later',
			number: 'T1-003',
			dueAt: NOW + 6 * 60 * 60_000,
		}
		draw({ feed: feedOf([ticket, later]) })
		expect(fresh()).toEqual([])
	})
})

describe('promised time and push-back on a ticket', () => {
	const onlineTicket = (patch: Partial<KdsTicket> = {}): KdsTicket => ({
		...ticket,
		id: 'web',
		source: 'online',
		channel: 'online',
		fulfillment: 'takeaway',
		tableLabel: null,
		number: 'W-1',
		promisedAt: Date.UTC(2026, 0, 1, 18, 40),
		promisedUntil: null,
		promisedVersion: 2,
		...patch,
	})
	const feedOf = (tickets: KdsTicket[]): KdsFeed => ({
		config: DEFAULT_KDS_CONFIG,
		configVersion: 1,
		tickets,
		serverNow: NOW,
		truncated: false,
	})
	const group = () => host.querySelector('[data-kitchen-delay]')

	it('shows nothing for a walk-in ticket', () => {
		draw({ feed: feedOf([ticket]) }, { timeZone: 'UTC' })
		expect(host.querySelector('[data-kitchen-promised]')).toBeNull()
		expect(group()).toBeNull()
	})

	it('says when a pickup is ready and sends +10 with the promised version', () => {
		draw({ feed: feedOf([onlineTicket()]) }, { timeZone: 'UTC' })
		expect(host.querySelector('[data-kitchen-promised]')!.textContent).toMatch(
			/^Ready around 6:40\sPM$/,
		)
		const buttons = [...group()!.querySelectorAll('button')]
		expect(buttons.map((button) => button.textContent)).toEqual([
			'+5',
			'+10',
			'+15',
		])
		expect(group()!.textContent).toContain('Push time back')
		act(() => buttons[1]!.click())
		expect(command).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				source: 'online',
				orderId: 'web',
				expectedVersion: ticket.version,
				action: 'delay',
				stationId: null,
				lineId: null,
				minutes: 10,
				expectedPromisedVersion: 2,
			}),
		)
	})

	it('shows an arrival range for delivery', () => {
		draw(
			{
				feed: feedOf([
					onlineTicket({
						fulfillment: 'delivery',
						promisedAt: Date.UTC(2026, 0, 1, 19, 5),
						promisedUntil: Date.UTC(2026, 0, 1, 19, 20),
					}),
				]),
			},
			{ timeZone: 'UTC' },
		)
		const text = host.querySelector('[data-kitchen-promised]')!.textContent!
		expect(text).toContain('Arriving')
		expect(text).toContain('7:05')
		expect(text).toContain('7:20')
	})

	it('hides the buttons on finished, cancelled and promise-less online tickets and disables them offline', () => {
		draw({
			feed: feedOf([
				onlineTicket({ id: 'a', completedAt: NOW }),
				onlineTicket({ id: 'b', cancelled: true }),
				onlineTicket({
					id: 'c',
					promisedAt: undefined,
					promisedVersion: undefined,
				}),
			]),
		})
		expect(group()).toBeNull()
		draw({ feed: feedOf([onlineTicket()]), stale: true })
		for (const button of group()!.querySelectorAll('button'))
			expect(button.disabled).toBe(true)
	})

	it.each([
		['stale_version', 'The time was already changed. Check it and try again.'],
		['delay_limit', "This order can't be pushed back any further."],
		['order_closed', 'This order is finished.'],
	])('says %s in kitchen words', (code, message) => {
		draw({
			feed: feedOf([onlineTicket()]),
			error: new KitchenError(code, 409),
		})
		expect(host.querySelector('[role="alert"]')!.textContent).toContain(message)
	})

	it('words a manager refusal for the time after a push-back tap', () => {
		draw({ feed: feedOf([onlineTicket()]) })
		act(() => group()!.querySelectorAll('button')[0]!.click())
		draw({
			feed: feedOf([onlineTicket()]),
			error: new KitchenError('manager_required', 403),
		})
		expect(host.querySelector('[role="alert"]')!.textContent).toContain(
			'A manager needs to sign in to change the time.',
		)
	})
})
