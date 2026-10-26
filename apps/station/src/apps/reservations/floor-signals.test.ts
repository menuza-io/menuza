// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Floor } from './Floor.tsx'
import { at, day, MIN, rsv } from './testing.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
const NOW = at(18 * 60)
let host: HTMLDivElement
let root: Root
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
		() => 960,
	)
	vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
		() => 600,
	)
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	vi.restoreAllMocks()
	i18n.activate('en')
})

const vip = { id: 'g', name: 'V', tags: [{ id: 't', name: 'VIP' }] }
function draw(
	reservations: ReturnType<typeof rsv>[],
	over: Partial<ComponentProps<typeof Floor>> = {},
) {
	const feed = day(reservations)
	const props: ComponentProps<typeof Floor> = {
		feed,
		area: feed.areas[0]!,
		now: NOW,
		picking: null,
		canReadGuest: true,
		onTable: vi.fn(),
		formatTime: (ms) => new Date(ms).toISOString().slice(11, 16),
		formatShort: (ms) => new Date(ms).toISOString().slice(11, 16),
		...over,
	}
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, h(Floor, props))))
}
const tile = (label: string) =>
	[...host.querySelectorAll('.bk-table')].find(
		(t) => t.querySelector('.bk-t-num')?.textContent === label,
	)!
const signals = (label: string) =>
	[...tile(label).querySelectorAll('.bk-signal')].map((s) =>
		s.getAttribute('data-signal'),
	)

describe('the guest signals on a table tile', () => {
	it('shows up to two, from the party seated there', () => {
		draw([
			rsv({
				start: 17 * 60,
				status: 'seated',
				seatedAt: NOW - 20 * MIN,
				tableIds: ['t2'],
				guest: vip,
				dietaryCodes: ['nut_allergy'],
				occasion: 'birthday',
			}),
		])
		expect(signals('2')).toEqual(['allergy', 'vip'])
	})
	it('shows them from the party due soon on an open table', () => {
		draw([
			rsv({
				start: 18 * 60 + 15,
				tableIds: ['t1'],
				occasion: 'birthday',
				paymentStatus: 'paid',
			}),
		])
		expect(signals('1')).toEqual(['occasion', 'deposit'])
	})
	it('shows none for a table with nothing to flag, or a booking hours away', () => {
		draw([
			rsv({ start: 21 * 60, tableIds: ['t10'], guest: vip }),
			rsv({
				start: 17 * 60,
				status: 'seated',
				seatedAt: NOW - 20 * MIN,
				tableIds: ['t2'],
			}),
		])
		expect(signals('10')).toEqual([])
		expect(signals('2')).toEqual([])
	})
	it('keeps them out of the table’s name for a screen reader (they are marks)', () => {
		draw([
			rsv({
				start: 17 * 60,
				status: 'seated',
				seatedAt: NOW - 20 * MIN,
				tableIds: ['t2'],
				guest: vip,
			}),
		])
		expect(
			tile('2').querySelector('.bk-signals')!.getAttribute('aria-hidden'),
		).toBe('true')
	})
})

describe('what a seated table says about time left', () => {
	const seated = () =>
		rsv({
			start: 17 * 60 + 30,
			status: 'seated',
			seatedAt: NOW - 30 * MIN,
			tableIds: ['t2'],
			durationMin: 90,
		})
	it('says "~60m left" in English, with the word for a tile that has room', () => {
		draw([seated()])
		const left = tile('2').querySelector('.bk-left')!
		expect(left.textContent).toContain('~60m')
		expect(left.textContent).toContain('left')
	})
	it('says the number and the short unit in Arabic, without the tilde or the word (the name keeps "left")', () => {
		i18n.loadAndActivate({
			locale: 'ar',
			messages: {},
		})
		draw([seated()])
		const left = tile('2').querySelector('.bk-left')!
		expect(left.textContent).not.toContain('~')
		expect(left.querySelector('.bk-left-word')).toBeNull()
		expect(left.querySelector('bdi')).not.toBeNull()
	})
	it('says nothing under a resetting tile that it already says inside it', () => {
		const feed = day(
			[
				rsv({
					start: 16 * 60,
					status: 'finished',
					finishedAt: NOW - 2 * MIN,
					tableIds: ['t2'],
				}),
			],
			{
				tables: [
					{
						id: 't2',
						areaId: 'a1',
						label: '2',
						minCovers: 1,
						maxCovers: 4,
						resetBufferMin: 10,
					},
				],
			},
		)
		draw([], { feed, area: feed.areas[0]! })
		const reset = host.querySelector('.bk-table[data-state="resetting"]')!
		expect(reset.textContent).toContain('8m')
		expect(reset.querySelector('.bk-caption')).toBeNull()
		// Picking a party up: the reason is said under it, as the tile steps back.
		draw([], {
			feed,
			area: feed.areas[0]!,
			picking: { partySize: 2, durationMin: 90 },
		})
		expect(
			host.querySelector('.bk-table[data-state="resetting"] .bk-caption')!
				.textContent,
		).toContain('Resetting')
	})
})
