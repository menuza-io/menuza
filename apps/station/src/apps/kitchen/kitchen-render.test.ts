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
const testPrint = vi.fn(async (_orderId: string, _answer: 'yes' | 'no') => true)
const issues: unknown[][] = []
beforeEach(() => {
	localStorage.clear()
	command.mockClear()
	testPrint.mockClear()
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
		testPrint,
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
	it('badges a free test order TEST and asks whether its ticket printed (#119)', () => {
		const feed: KdsFeed = {
			config: DEFAULT_KDS_CONFIG,
			configVersion: 1,
			tickets: [{ ...ticket, isTest: true, testPrintAnswer: null }],
			serverNow: NOW,
			truncated: false,
		}
		draw({ feed })
		const mark = host.querySelector('[data-kitchen-test]')!
		expect(mark.textContent).toContain('TEST')
		expect(mark.textContent).toContain('Did the ticket print?')
		const yes = host.querySelector<HTMLButtonElement>('[data-test-print-yes]')!
		const no = host.querySelector<HTMLButtonElement>('[data-test-print-no]')!
		expect(yes.textContent).toBe('Yes')
		expect(no.textContent).toBe('No')
		act(() => yes.click())
		expect(testPrint).toHaveBeenCalledExactlyOnceWith('ticket', 'yes')
		act(() => no.click())
		expect(testPrint).toHaveBeenLastCalledWith('ticket', 'no')
	})
	it('shows a group order’s dishes under "For Sam", once per person (#170)', () => {
		const dish = (id: string, forName: string, name: string) => ({
			...ticket.lines[0]!,
			id,
			name,
			forName,
		})
		const feed: KdsFeed = {
			config: DEFAULT_KDS_CONFIG,
			configVersion: 1,
			tickets: [
				{
					...ticket,
					lines: [
						dish('a', 'Hana', 'Burger'),
						dish('b', 'Sam', 'Fries'),
						dish('c', 'Sam', 'Salad'),
						dish('d', 'Lee', 'Soup'),
					],
				},
			],
			serverNow: NOW,
			truncated: false,
		}
		draw({ feed })
		const heads = [...host.querySelectorAll('[data-kitchen-for]')].map(
			(node) => node.textContent,
		)
		expect(heads).toEqual(['For Hana', 'For Sam', 'For Lee'])
		// A normal ticket has none.
		draw({ feed: { ...feed, tickets: [ticket] } })
		expect(host.querySelector('[data-kitchen-for]')).toBeNull()
	})
	it('says the ticket printed, or points to printer setup, once answered (#119)', () => {
		const ticketWith = (answer: 'yes' | 'no') =>
			({
				config: DEFAULT_KDS_CONFIG,
				configVersion: 1,
				tickets: [{ ...ticket, isTest: true, testPrintAnswer: answer }],
				serverNow: NOW,
				truncated: false,
			}) satisfies KdsFeed
		draw({ feed: ticketWith('yes') })
		expect(host.querySelector('[data-test-print="yes"]')).not.toBeNull()
		expect(host.querySelector('[data-test-print-yes]')).toBeNull()
		act(() => root.unmount())
		root = createRoot(host)
		draw({ feed: ticketWith('no') })
		expect(host.querySelector('[data-test-print="no"]')!.textContent).toContain(
			'Settings',
		)
		// The question stays so the answer can be corrected after a fix.
		expect(host.querySelector('[data-test-print-yes]')).not.toBeNull()
	})
	it('shows nothing about printing on a real order (#119)', () => {
		draw()
		expect(host.querySelector('[data-kitchen-test]')).toBeNull()
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

describe('utensils and large order on a ticket (#257, #355)', () => {
	const online = (patch: Partial<KdsTicket> = {}): KdsTicket => ({
		...ticket,
		id: 'web',
		source: 'online',
		channel: 'online',
		fulfillment: 'takeaway',
		tableLabel: null,
		number: 'W-1',
		...patch,
	})
	const feedOf = (tickets: KdsTicket[]): KdsFeed => ({
		config: DEFAULT_KDS_CONFIG,
		configVersion: 1,
		tickets,
		serverNow: NOW,
		truncated: false,
	})
	const utensils = () => host.querySelector('[data-kitchen-utensils]')
	const largeOrder = () => host.querySelector('[data-kitchen-large-order]')

	it('says "Utensils: yes" or "No utensils" as its own line, not in the notes', () => {
		draw({ feed: feedOf([online({ utensilsRequested: true })]) })
		expect(utensils()!.textContent).toBe('Utensils: yes')
		draw({ feed: feedOf([online({ utensilsRequested: false })]) })
		expect(utensils()!.textContent).toBe('No utensils')
		// A dish note stays a dish note: the answer is never inside it.
		expect(host.textContent).toContain('No salt')
		expect(utensils()!.closest('li')).toBeNull()
	})

	it('shows nothing when the guest was not asked, or the node is older', () => {
		draw({ feed: feedOf([online({ utensilsRequested: null })]) })
		expect(utensils()).toBeNull()
		draw({ feed: feedOf([online()]) })
		expect(utensils()).toBeNull()
		draw({ feed: feedOf([ticket]) })
		expect(utensils()).toBeNull()
	})

	it('says why the time is later for a large order, and nothing for a normal one', () => {
		draw({ feed: feedOf([online({ largeOrderExtraMinutes: 15 })]) })
		expect(largeOrder()!.textContent).toBe('Large order +15 min')
		draw({ feed: feedOf([online({ largeOrderExtraMinutes: 0 })]) })
		expect(largeOrder()).toBeNull()
		draw({ feed: feedOf([online()]) })
		expect(largeOrder()).toBeNull()
	})
})

describe('the kitchen station a terminal profile sets (#373)', () => {
	const twoStations = {
		...DEFAULT_KDS_CONFIG,
		stations: [
			{ id: 'kitchen', name: 'Kitchen', itemIds: [] },
			{ id: 'bar', name: 'Bar', itemIds: [] },
		],
	}
	const select = () =>
		host.querySelector<HTMLSelectElement>('select[aria-label="Prep station"]')!
	const feed = (): KdsFeed => ({
		config: twoStations,
		configVersion: 1,
		tickets: [ticket],
		serverNow: NOW,
		truncated: false,
	})

	it('shows only that station, and the screen cannot choose another', () => {
		draw(
			{ feed: feed() },
			{ settings: { ...loadSettings(), managed: { kdsStationId: 'bar' } } },
		)
		expect(select().value).toBe('bar')
		expect(select().disabled).toBe(true)
	})

	it('leaves the screen its own choice when nothing sets it', () => {
		localStorage.clear()
		draw({ feed: feed() })
		expect(select().disabled).toBe(false)
		expect(select().value).toBe('')
	})

	it('ignores a station this location does not have', () => {
		draw(
			{ feed: feed() },
			{ settings: { ...loadSettings(), managed: { kdsStationId: 'gone' } } },
		)
		expect(select().value).toBe('')
	})
})

describe('kitchen highlights and Check ID (#294, #167)', () => {
	const withLines = (over: Partial<KdsTicket> = {}): KdsTicket => ({
		...ticket,
		lines: [
			{
				...ticket.lines[0]!,
				id: 'plain',
				name: 'Plain dish',
				instructions: '',
			},
			{
				...ticket.lines[0]!,
				id: 'burger',
				name: 'Burger',
				instructions: '',
				options: [
					{
						name: 'No onions',
						quantity: 1,
						half: null,
						highlight: 'attention',
					},
					{ name: 'Extra cheese', quantity: 1, half: null },
				],
			},
			{
				...ticket.lines[0]!,
				id: 'nuts',
				name: 'Satay',
				instructions: '',
				highlight: 'allergy',
			},
		],
		...over,
	})
	const feedOf = (tickets: KdsTicket[]): KdsFeed => ({
		config: DEFAULT_KDS_CONFIG,
		configVersion: 1,
		tickets,
		serverNow: NOW,
		truncated: false,
	})

	it('highlights a "No onions" option with an icon and a word, never colour alone', () => {
		draw({ feed: feedOf([withLines()]) })
		const mark = host.querySelector(
			'li [data-highlight="attention"].kitchen-mark',
		)!
		expect(mark.textContent).toBe('Attention')
		expect(mark.querySelector('svg')).not.toBeNull()
		// The line itself carries the bar, and the sibling option has no mark.
		expect(host.textContent).toContain('Extra cheese')
		const marks = [...host.querySelectorAll('li .kitchen-mark')].map(
			(el) => el.textContent,
		)
		expect(marks).toEqual(['Attention', 'Allergy'])
	})

	it('leaves a dish with no highlight as it was', () => {
		draw({ feed: feedOf([withLines()]) })
		const plain = [...host.querySelectorAll('li')].find((li) =>
			li.textContent?.includes('Plain dish'),
		)!
		expect(plain.getAttribute('data-highlight')).toBeNull()
		expect(plain.querySelector('.kitchen-mark')).toBeNull()
	})

	it('highlights the whole header of a guest who stated an allergy, with words', () => {
		draw({ feed: feedOf([withLines({ guestAllergy: true })]) })
		const head = host.querySelector('header.kitchen-ticket-head')!
		expect(head.getAttribute('data-guest-allergy')).toBe('true')
		const note = head.querySelector('[data-kitchen-guest-allergy]')!
		expect(note.textContent).toBe('Allergy stated by guest')
		expect(note.querySelector('svg')).not.toBeNull()
	})

	it('shows no allergy header and no Check ID on an ordinary ticket', () => {
		draw({ feed: feedOf([withLines()]) })
		expect(host.querySelector('[data-guest-allergy]')).toBeNull()
		expect(host.querySelector('[data-kitchen-check-id]')).toBeNull()
	})

	it('says Check ID on an order with alcohol', () => {
		draw({ feed: feedOf([withLines({ checkId: true })]) })
		const badge = host.querySelector('[data-kitchen-check-id]')!
		expect(badge.textContent).toBe('Check ID')
		expect(badge.querySelector('svg')).not.toBeNull()
	})
})
