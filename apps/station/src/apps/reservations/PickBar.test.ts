// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { createElement as h, act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DayTable } from './feed.ts'
import { NoFitBanner, PickBar } from './PickBar.tsx'
import { day } from './testing.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
})

const tables = day([], {
	tables: [
		{ id: 't6', areaId: 'a1', label: '6', minCovers: 2, maxCovers: 6 },
		{ id: 't8', areaId: 'a1', label: '8', minCovers: 2, maxCovers: 4 },
		{ id: 't1', areaId: 'a1', label: '1', minCovers: 1, maxCovers: 2 },
	],
}).tables as DayTable[]
const [t6, t8, t1] = tables as [DayTable, DayTable, DayTable]

type BarProps = ComponentProps<typeof PickBar>
const bar = (over: Partial<BarProps> = {}): BarProps => ({
	name: 'Walk-in',
	partySize: 9,
	covers: null,
	wholeParty: 9,
	joined: null,
	canCombine: true,
	forced: false,
	onCombine: () => undefined,
	onSeatJoined: () => undefined,
	onRemoveTable: () => undefined,
	onBackToOne: () => undefined,
	onCancel: () => undefined,
	...over,
})
const draw = (element: ReturnType<typeof h>) =>
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, element)))
const text = () => host.textContent ?? ''
const button = (label: string) =>
	[...host.querySelectorAll('button')].find(
		(b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label,
	)
const press = (label: string) =>
	act(() => {
		const target = button(label)
		if (!target) throw new Error(`no button ${label}`)
		target.click()
	})

describe('the bar over the floor while a party is in hand', () => {
	it('says who to seat, and offers to combine tables', () => {
		const onCombine = vi.fn()
		draw(h(PickBar, bar({ onCombine })))
		expect(text()).toContain('Tap a table for Walk-in, party of 9')
		press('Combine tables')
		expect(onCombine).toHaveBeenCalled()
	})
	it('offers no combining when the "no table fits" offer says it already', () => {
		draw(h(PickBar, bar({ canCombine: false })))
		expect(button('Combine tables')).toBeUndefined()
	})
	it('says how many are being seated when only some are', () => {
		draw(
			h(PickBar, bar({ partySize: 3, covers: 3, wholeParty: 5, name: 'Dina' })),
		)
		expect(text()).toContain('Tap a table for Dina: 3 of 5')
	})
	it('says any open table when the host chose to seat them anyway', () => {
		draw(h(PickBar, bar({ forced: true })))
		expect(text()).toContain('Tap any open table for Walk-in, party of 9')
	})
	it('cancels', () => {
		const onCancel = vi.fn()
		draw(h(PickBar, bar({ onCancel })))
		press('Cancel')
		expect(onCancel).toHaveBeenCalled()
	})
})

describe('joining tables in the bar', () => {
	it('asks for a first table when none is chosen, and cannot seat yet', () => {
		draw(h(PickBar, bar({ joined: [] })))
		expect(text()).toContain('Combine tables for Walk-in, party of 9')
		expect(text()).toContain('Tap a free table, then one beside it.')
		expect((button('Seat') as HTMLButtonElement).disabled).toBe(true)
	})
	it('shows the chosen tables as chips and the seats they make, and seats the party', () => {
		const onSeatJoined = vi.fn()
		draw(h(PickBar, bar({ joined: [t6, t8], onSeatJoined })))
		expect(text()).toContain('Seat 9 at 6 + 8 (10 seats)')
		const seat = button('Seat') as HTMLButtonElement
		expect(seat.disabled).toBe(false)
		press('Seat')
		expect(onSeatJoined).toHaveBeenCalled()
	})
	it('says how many seats are still missing, and does not seat', () => {
		draw(h(PickBar, bar({ joined: [t6, t1] })))
		expect(text()).toContain('6 + 1: seats 8, needs 1 more seat')
		expect((button('Seat') as HTMLButtonElement).disabled).toBe(true)
		draw(h(PickBar, bar({ joined: [t1] })))
		expect(text()).toContain('1: seats 2, needs 7 more seats')
	})
	it('takes a table out of the group from its chip', () => {
		const onRemoveTable = vi.fn()
		draw(h(PickBar, bar({ joined: [t6, t8], onRemoveTable })))
		press('Take table 8 out')
		expect(onRemoveTable).toHaveBeenCalledWith('t8')
	})
	it('goes back to one table', () => {
		const onBackToOne = vi.fn()
		draw(h(PickBar, bar({ joined: [t6], onBackToOne })))
		press('One table')
		expect(onBackToOne).toHaveBeenCalled()
	})
	it('says it is seating only some of the party', () => {
		draw(
			h(
				PickBar,
				bar({
					joined: [t6],
					partySize: 3,
					covers: 3,
					wholeParty: 5,
					name: 'Dina',
				}),
			),
		)
		expect(text()).toContain('Combine tables for Dina: 3 of 5')
	})
})

describe('when no single table seats the party', () => {
	type Props = ComponentProps<typeof NoFitBanner>
	const banner = (over: Partial<Props> = {}): Props => ({
		partySize: 9,
		biggest: 8,
		tooBig: true,
		group: {
			tableIds: ['t6', 't8'],
			tables: [t6, t8],
			seats: 10,
			comboId: null,
		},
		quoteMin: 35,
		canWaitlist: true,
		onCombine: () => undefined,
		onWaitlist: () => undefined,
		onAnyway: () => undefined,
		...over,
	})
	it('says so calmly, with the three things that can be done', () => {
		const onCombine = vi.fn()
		const onWaitlist = vi.fn()
		const onAnyway = vi.fn()
		draw(h(NoFitBanner, banner({ onCombine, onWaitlist, onAnyway })))
		expect(text()).toContain('No single table seats 9.')
		expect(text()).toContain('The biggest seats 8.')
		press('Combine tables')
		expect(onCombine).toHaveBeenCalled()
		// The long sentence for a wide screen, a short one for a phone: one is hidden by CSS.
		const waitlist = [...host.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Put on the waitlist, quote about 35 min'),
		)!
		expect(waitlist.textContent).toContain('Waitlist, about 35 min')
		act(() => waitlist.click())
		expect(onWaitlist).toHaveBeenCalled()
		press('Seat anyway at…')
		expect(onAnyway).toHaveBeenCalled()
	})
	it('says the tables are busy, not too small, for a party that would fit one', () => {
		draw(h(NoFitBanner, banner({ partySize: 4, tooBig: false })))
		expect(text()).toContain('No table is free for 4 right now.')
		expect(text()).not.toContain('No single table seats')
		expect(text()).not.toContain('The biggest seats')
		// "Seat anyway at a small table" is for a party no table seats.
		expect(button('Seat anyway at…')).toBeUndefined()
	})
	it('says there are no free tables to combine, and cannot', () => {
		draw(h(NoFitBanner, banner({ group: null })))
		const none = button('No free tables to combine') as HTMLButtonElement
		expect(none.disabled).toBe(true)
	})
	it('offers no waitlist for a party that is a booking, and says no wait when none is quoted', () => {
		draw(h(NoFitBanner, banner({ canWaitlist: false })))
		expect(text()).not.toContain('waitlist')
		draw(h(NoFitBanner, banner({ quoteMin: null })))
		expect(button('Put on the waitlist')).toBeDefined()
	})
})
