import { describe, expect, it } from 'vitest'
import {
	buildLocationsCsv,
	planLocationsCsv,
	type CsvLocation,
} from './locations-csv.ts'

const locations: CsvLocation[] = [
	{
		id: 'a',
		name: 'Austin',
		slug: 'austin',
		phone: '555-0100',
		isActive: true,
		tags: ['Texas'],
	},
	{
		id: 'b',
		name: 'Boston',
		slug: 'boston',
		phone: null,
		isActive: true,
		tags: [],
	},
	{
		id: 'c',
		name: 'Cairo',
		slug: 'cairo',
		phone: null,
		isActive: false,
		tags: ['Texas', 'North'],
	},
]
const byId = new Map(locations.map((l) => [l.id, l]))
const tagNames = ['Texas', 'North']

describe('locations CSV', () => {
	it('round trips: the download read back is no change', () => {
		const plan = planLocationsCsv(buildLocationsCsv(locations), byId, tagNames)
		expect(plan).toMatchObject({
			ok: true,
			problems: [],
			changes: [],
			newTags: [],
		})
	})

	it('reads edits to phone, active and tags and lists new tags', () => {
		const csv = [
			'id,name,slug,phone,active,tags',
			'a,Austin,austin,555-0199,yes,Texas',
			'b,Boston,boston,,no,"East; Texas"',
		].join('\n')
		const plan = planLocationsCsv(csv, byId, tagNames)
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.problems).toEqual([])
		expect(plan.newTags).toEqual(['East'])
		expect(plan.changes).toEqual([
			expect.objectContaining({
				locationId: 'a',
				fields: ['phone'],
				write: { phone: '555-0199' },
			}),
			expect.objectContaining({
				locationId: 'b',
				fields: ['active', 'tags'],
				write: { isActive: false, tags: ['East', 'Texas'] },
			}),
		])
	})

	it('names every bad row and still lists the good ones (the caller applies nothing)', () => {
		const csv = [
			'id,name,slug,phone,active,tags',
			'a,Austin,austin,555-0199,yes,Texas',
			'zzz,Nowhere,x,,yes,',
			'b,Boston,boston,not a phone!,yes,',
			'c,Cairo,cairo,,maybe,',
			'a,Austin,austin,,yes,',
		].join('\n')
		const plan = planLocationsCsv(csv, byId, tagNames)
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.problems.map((p) => [p.row, p.problem])).toEqual([
			[3, 'unknown_location'],
			[4, 'bad_phone'],
			[5, 'bad_active'],
			[6, 'duplicate_row'],
		])
	})

	it('a missing tags column leaves tags alone, an empty cell clears them', () => {
		const withoutColumn = planLocationsCsv(
			'id,phone\nc,555-1111',
			byId,
			tagNames,
		)
		if (!withoutColumn.ok) throw new Error()
		expect(withoutColumn.changes[0]!.fields).toEqual(['phone'])
		const cleared = planLocationsCsv('id,tags\nc,', byId, tagNames)
		if (!cleared.ok) throw new Error()
		expect(cleared.changes[0]).toMatchObject({ write: { tags: [] } })
	})

	it('refuses a file that is not the template, an empty file, and one that breaks the tag limit', () => {
		expect(planLocationsCsv('', byId, tagNames)).toEqual({
			ok: false,
			error: 'empty',
		})
		expect(planLocationsCsv('name,phone\nx,y', byId, tagNames)).toEqual({
			ok: false,
			error: 'not_template',
		})
		expect(planLocationsCsv('id,bogus\na,1', byId, tagNames)).toEqual({
			ok: false,
			error: 'not_template',
		})
		const many = Array.from({ length: 60 }, (_, i) => `t${i}`).join(';')
		expect(planLocationsCsv(`id,tags\na,${many}`, byId, tagNames)).toEqual({
			ok: false,
			error: 'tag_limit',
		})
	})

	it('guards against spreadsheet formulas on the way out and in', () => {
		const csv = buildLocationsCsv([
			{ ...locations[0]!, name: '=HYPERLINK("x")', tags: ['+cmd'] },
		])
		expect(csv).toContain("'=HYPERLINK")
		const plan = planLocationsCsv("id,phone\na,'555-0100", byId, tagNames)
		if (!plan.ok) throw new Error()
		// A guarded cell reads back as it was written.
		expect(plan.changes).toEqual([])
	})
})
