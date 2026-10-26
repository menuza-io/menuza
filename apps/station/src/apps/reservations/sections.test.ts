import { describe, expect, it } from 'vitest'
import { bestFit, tableState } from './feed.ts'
import {
	floorSections,
	initialsOf,
	sectionByTable,
	sectionColor,
	sectionLayoutFor,
	sectionLoads,
	upNext,
} from './sections.ts'
import { at, day, rsv, SERVICES } from './testing.ts'

const LAYOUT = {
	id: 'layout',
	name: 'Two sections',
	sections: [
		{
			id: 'inside',
			name: 'Inside',
			colorToken: 'blue',
			sort: 0,
			tableIds: ['t1', 't2', 't10'],
		},
		{
			id: 'patio',
			name: 'Patio',
			colorToken: null,
			sort: 1,
			tableIds: ['p1', 'gone'],
		},
	],
}
const withSections = (
	reservations: Parameters<typeof day>[0] = [],
	extra: Record<string, unknown> = {},
) =>
	day(reservations, {
		services: SERVICES.map((service) => ({
			...service,
			sectionLayoutId: 'layout',
		})),
		sectionLayouts: [LAYOUT],
		sectionAssignments: [
			{
				serviceId: 'dinner',
				sectionId: 'inside',
				staffId: 's1',
				serverLabel: 'Maya S.',
			},
		],
		...extra,
	})

describe('server sections', () => {
	it('are the service’s own layout, coloured, with who works each', () => {
		const sections = floorSections(withSections(), 'dinner')
		expect(sections).toEqual([
			{
				id: 'inside',
				name: 'Inside',
				color: '#3b82f6',
				tableIds: ['t1', 't2', 't10'],
				server: { staffId: 's1', name: 'Maya S.' },
			},
			// A table no longer on the floor drops out; no colour takes the palette's next.
			{
				id: 'patio',
				name: 'Patio',
				color: '#10b981',
				tableIds: ['p1'],
				server: null,
			},
		])
		// Another service of the day has nobody assigned yet.
		expect(floorSections(withSections(), 'lunch').every((s) => !s.server)).toBe(
			true,
		)
		expect(sectionByTable(sections).get('p1')?.id).toBe('patio')
	})

	it('fall back to the only layout, and are off for "All day" or with none drawn', () => {
		const feed = withSections([], { services: SERVICES })
		expect(sectionLayoutFor(feed, 'dinner')?.id).toBe('layout')
		expect(sectionLayoutFor(feed, null)).toBeNull()
		expect(floorSections(day([]), 'dinner')).toEqual([])
	})

	it('read colours and initials as a host would', () => {
		expect(sectionColor('#AB12CD', 0)).toBe('#ab12cd')
		expect(sectionColor('rose', 0)).toBe('#f43f5e')
		expect(sectionColor('neutral', 2)).toBe('#f59e0b')
		expect(initialsOf('Maya S.')).toBe('MS')
		expect(initialsOf('omar')).toBe('OM')
		expect(initialsOf('  ')).toBe('')
		expect(initialsOf('ليلى ك')).toBe('لك')
	})

	it('count covers now and lately, and seat next where it has been quietest', () => {
		const now = at(19 * 60)
		const feed = withSections(
			[
				// Inside sat a four ten minutes ago, and has a couple from earlier.
				rsv({
					start: 18 * 60 + 50,
					status: 'seated',
					partySize: 4,
					tableIds: ['t2'],
					seatedAt: now - 10 * 60_000,
				}),
				rsv({
					start: 17 * 60,
					status: 'seated',
					partySize: 2,
					tableIds: ['t1'],
					seatedAt: at(17 * 60),
				}),
			],
			{
				sectionAssignments: [
					{ serviceId: 'dinner', sectionId: 'inside', serverLabel: 'Maya S.' },
					{ serviceId: 'dinner', sectionId: 'patio', serverLabel: 'Omar H.' },
				],
			},
		)
		const loads = sectionLoads(floorSections(feed, 'dinner'), feed, now)
		expect(loads.map(({ section, ...load }) => [section.id, load])).toEqual([
			['inside', { covers: 6, recentCovers: 4, free: 1, tables: 3 }],
			['patio', { covers: 0, recentCovers: 0, free: 1, tables: 1 }],
		])
		expect(upNext(loads)).toBe('patio')
		// The patio's only table taken: Maya is up, though she was sat lately.
		const full = withSections(
			[
				...feed.reservations,
				rsv({
					start: 18 * 60,
					status: 'seated',
					tableIds: ['p1'],
					seatedAt: now - 60 * 60_000,
				}),
			],
			{ sectionAssignments: feed.sectionAssignments },
		)
		expect(upNext(sectionLoads(floorSections(full, 'dinner'), full, now))).toBe(
			'inside',
		)
		// Nobody assigned anywhere: no rotation.
		expect(
			upNext(
				sectionLoads(
					floorSections(withSections(), 'lunch'),
					withSections(),
					now,
				),
			),
		).toBeNull()
	})

	it('steer the suggested table to the section that is up next, among tables of one size', () => {
		const feed = withSections()
		const now = at(19 * 60)
		const candidates = feed.tables.map((table) => ({
			table,
			state: tableState(table, feed, now),
		}))
		const party = { partySize: 2, durationMin: 90 }
		expect(bestFit(candidates, party, now, feed)).toBe('t1')
		const patioFirst = (id: string) => (id === 'p1' ? 0 : 1)
		expect(bestFit(candidates, party, now, feed, patioFirst)).toBe('p1')
		// Size still comes first: a four never goes to the patio two-top.
		expect(
			bestFit(candidates, { ...party, partySize: 4 }, now, feed, patioFirst),
		).toBe('t2')
	})
})
