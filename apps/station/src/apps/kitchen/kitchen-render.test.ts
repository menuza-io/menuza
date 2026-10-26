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
