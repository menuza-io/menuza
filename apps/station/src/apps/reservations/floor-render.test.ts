// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tableState } from './feed.ts'
import { Floor } from './Floor.tsx'
import { fitRoom } from './floorfit.ts'
import { at, day, MIN, rsv } from './testing.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
const NOW = at(18 * 60)
const issues: unknown[][] = []
let host: HTMLDivElement
let root: Root
let frame = { w: 960, h: 600 }
beforeEach(() => {
	issues.length = 0
	frame = { w: 960, h: 600 }
	vi.spyOn(console, 'error').mockImplementation((...args) => {
		issues.push(args)
	})
	vi.spyOn(console, 'warn').mockImplementation((...args) => {
		issues.push(args)
	})
	vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
		() => frame.w,
	)
	vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
		() => frame.h,
	)
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	try {
		expect(issues).toEqual([])
	} finally {
		vi.restoreAllMocks()
	}
})

function fixture(drawn = true) {
	return day(
		[
			rsv({ start: 18 * 60 + 10, tableIds: ['soon'], firstName: 'Due Guest' }),
			rsv({
				start: 17 * 60 + 30,
				status: 'partially_seated',
				partySize: 4,
				seatedCovers: 2,
				seatedAt: NOW - 15 * MIN,
				tableIds: ['seated'],
				firstName: 'Seated Guest',
			}),
			rsv({
				start: 16 * 60,
				status: 'finished',
				finishedAt: NOW - 2 * MIN,
				tableIds: ['resetting'],
			}),
		],
		{
			tables: ['open', 'soon', 'seated', 'blocked', 'resetting'].map(
				(id, i) => ({
					id,
					areaId: 'a1',
					label: `T${i}`,
					minCovers: 1,
					maxCovers: i === 0 ? 999 : 4,
					shape: ['square', 'round', 'oval', 'rect', 'custom'][i],
					x: drawn ? i * 150 : 0,
					y: 0,
					w: i === 2 ? 120 : 80,
					h: 80,
					rotation: i === 2 ? 37 : i === 3 ? 90 : 0,
					resetBufferMin: 10,
				}),
			),
			elements: ['wall', 'bar', 'zone', 'door', 'window', 'plant', 'label'].map(
				(kind, i) => ({
					id: kind,
					areaId: 'a1',
					kind,
					label: kind,
					x: i * 120,
					y: 180,
					w: 60,
					h: 20,
					rotation: i === 0 ? 25 : 0,
				}),
			),
			blocks: [
				{
					id: 'block',
					tableId: 'blocked',
					startAt: NOW - MIN,
					endAt: NOW + 30 * MIN,
					reason: 'Private',
				},
			],
		},
	)
}
function draw(
	feed = fixture(),
	over: Partial<ComponentProps<typeof Floor>> = {},
) {
	const props: ComponentProps<typeof Floor> = {
		feed,
		area: feed.areas[0]!,
		now: NOW,
		picking: null,
		onTable: vi.fn(),
		formatTime: (ms) => new Date(ms).toISOString().slice(11, 16),
		formatShort: (ms) => new Date(ms).toISOString().slice(11, 16),
		...over,
	}
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, h(Floor, props))))
	return props
}

describe('simple floor shapes preserve room and interaction geometry', () => {
	it.each([
		{ w: 960, h: 600 },
		{ w: 240, h: 360 },
		{ w: 720, h: 320 },
	])(
		'keeps fitted coordinates, rotation, landmarks and actions at $w × $h',
		(size) => {
			frame = size
			const props = draw()
			const expected = fitRoom({
				tables: props.feed.tables,
				extras: props.feed.elements,
				frame: { w: size.w, h: size.h - 30 },
			})
			const plan = host.querySelector<HTMLElement>('.bk-plan')!
			expect(plan.style.getPropertyValue('--plan-w')).toBe(
				`${expected.width}px`,
			)
			expect(plan.style.getPropertyValue('--plan-h')).toBe(
				`${expected.height + 30}px`,
			)
			expect(
				host.querySelector('.bk-floor-frame')!.getAttribute('data-scroll'),
			).toBe(String(expected.scrolls))
			const buttons = [
				...host.querySelectorAll<HTMLButtonElement>('button.floor-table'),
			]
			expect(host.querySelectorAll('button')).toHaveLength(5)
			expect(buttons.map((b) => b.dataset.state)).toEqual([
				'open',
				'soon',
				'seated',
				'blocked',
				'resetting',
			])
			buttons.forEach((button, i) => {
				const table = props.feed.tables[i]!
				const box = button.parentElement!
				const px = expected.tables.get(table.id)!
				expect(box.style.getPropertyValue('--l')).toBe(`${px.left}px`)
				expect(box.style.getPropertyValue('--t')).toBe(`${px.top}px`)
				expect(box.style.getPropertyValue('--w')).toBe(`${px.width}px`)
				expect(box.style.getPropertyValue('--h')).toBe(`${px.height}px`)
				expect(px.width).toBeGreaterThanOrEqual(44)
				expect(px.height).toBeGreaterThanOrEqual(44)
				expect(button.style.getPropertyValue('--turn')).toBe(
					table.rotation ? `${table.rotation}deg` : '',
				)
				expect(
					button.querySelector('.bk-table-words.floor-unturn'),
				).not.toBeNull()
				expect(
					button.querySelector('.bk-chairs,.bk-chair,.bk-tabletop'),
				).toBeNull()
				expect(button.classList.contains('rounded-full')).toBe(
					table.shape === 'round' || table.shape === 'oval',
				)
				expect(button.querySelector('button,a,input,[tabindex]')).toBeNull()
				act(() => button.click())
				expect(props.onTable).toHaveBeenNthCalledWith(
					i + 1,
					table,
					tableState(table, props.feed, NOW),
				)
			})
			expect(buttons[0]!.textContent).toContain('999')
			expect(buttons[0]!.getAttribute('aria-label')).toContain('999')
			expect(buttons[1]!.textContent).toContain('18:10')
			expect(buttons[2]!.textContent).toContain('2/4')
			expect(buttons[2]!.querySelector('.bk-left')).not.toBeNull()
			expect(host.querySelector('.bk-elapsed')).not.toBeNull()
			expect(buttons[4]!.textContent).toContain('8m')
			expect(
				plan.querySelectorAll(':scope > .bk-box:not(.bk-table)'),
			).toHaveLength(7)
			for (const label of ['bar', 'zone', 'door', 'window', 'plant', 'label'])
				expect(plan.textContent).toContain(label)
		},
	)

	it('keeps best-fit and blocked/resetting reasons reachable while picking', () => {
		draw(fixture(), { picking: { partySize: 2, durationMin: 60 } })
		expect(host.querySelectorAll('[data-best="true"]')).toHaveLength(1)
		expect(host.querySelector('.bk-bestfit')!.textContent).toContain('Best fit')
		expect(
			host
				.querySelector('.floor-table[data-state="blocked"]')!
				.getAttribute('data-fits'),
		).toBe('false')
		expect(
			host
				.querySelector('.floor-table[data-state="resetting"]')!
				.getAttribute('data-fits'),
		).toBe('false')
		expect(
			host.querySelector('.bk-table[data-state="resetting"] .bk-caption')!
				.textContent,
		).toContain('Resetting')
	})

	it('keeps a chosen table pressed and marked without adding a focus stop', () => {
		draw(fixture(), {
			picking: { partySize: 2, durationMin: 60 },
			join: (table) =>
				table.id === 'open' ? { kind: 'selected' } : { kind: 'far' },
		})
		const chosen = host.querySelector('button[data-chosen="true"]')!
		expect(chosen.getAttribute('aria-pressed')).toBe('true')
		expect(
			chosen.querySelector('.bk-chosen-mark use')!.getAttribute('href'),
		).toMatch(/#check$/)
		expect(host.querySelectorAll('button')).toHaveLength(5)
	})

	it('retains the undrawn-grid placement path and accurate capacity text', () => {
		draw(fixture(false))
		expect(host.querySelector('.bk-plan')!.getAttribute('data-grid')).toBe(
			'true',
		)
		const box = host.querySelector<HTMLElement>('.bk-table')!
		expect(box.style.getPropertyValue('--l')).toMatch(/%$/)
		expect(box.style.getPropertyValue('--w')).toMatch(/%$/)
		expect(box.querySelectorAll('.bk-chair,.bk-tabletop')).toHaveLength(0)
		expect(box.textContent).toContain('999')
	})

	it('preserves a saved very long T7 as a plain rectangular table', () => {
		const feed = day([], {
			tables: [
				{
					id: 'long',
					areaId: 'a1',
					label: 'T7',
					minCovers: 2,
					maxCovers: 4,
					x: 0,
					y: 0,
					w: 740,
					h: 100,
					shape: 'rect',
				},
				{
					id: 'square',
					areaId: 'a1',
					label: 'T1',
					minCovers: 2,
					maxCovers: 4,
					x: 900,
					y: 0,
					w: 100,
					h: 100,
				},
			],
		})
		const original = feed.tables.map((t) => ({ ...t }))
		draw(feed)
		const expected = fitRoom({
			tables: feed.tables,
			extras: [],
			frame: { w: frame.w, h: frame.h - 30 },
		})
		const buttons = [
			...host.querySelectorAll<HTMLButtonElement>('button.floor-table'),
		]
		const long = expected.tables.get('long')!
		expect(buttons[0]!.parentElement!.style.getPropertyValue('--w')).toBe(
			`${long.width}px`,
		)
		expect(buttons[0]!.parentElement!.style.getPropertyValue('--h')).toBe(
			`${long.height}px`,
		)
		expect(long.width / long.height).toBeCloseTo(7.4)
		expect(buttons[0]!.querySelector('.bk-chair,.bk-tabletop')).toBeNull()
		expect(buttons[0]!.classList.contains('rounded-full')).toBe(false)
		expect(buttons[0]!.textContent).toContain('T7')
		expect(feed.tables).toEqual(original)
	})
})
