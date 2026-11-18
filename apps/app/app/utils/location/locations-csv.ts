import {
	LOCATION_TAG_NAME_MAX_LENGTH,
	locationTagNameKey,
	MAX_LOCATION_TAGS,
	validateLocationTagName,
} from '@repo/common/location-tags'
import { toCsv } from '@repo/staffing'
import { parseDelimited } from '#app/utils/staffing/staff-import.ts'

/**
 * Locations as a spreadsheet and bulk edit by upload (#374). The file is read
 * against the current locations and nothing is written unless every row is
 * fine: one bad row means the whole file is refused, with the row named. The
 * same plan-then-apply shape as the menu spreadsheet.
 */

export const LOCATIONS_CSV_COLUMNS = [
	'id',
	'name',
	'slug',
	'phone',
	'active',
	'tags',
] as const
export type LocationsCsvColumn = (typeof LOCATIONS_CSV_COLUMNS)[number]

/** Columns a person may change by upload; `id`, `name` and `slug` only identify. */
export const LOCATIONS_CSV_EDITABLE = ['phone', 'active', 'tags'] as const

export const LOCATIONS_CSV_MAX_ROWS = 500
export const LOCATIONS_CSV_MAX_BYTES = 500_000
export const LOCATION_PHONE_MAX_LENGTH = 30

export type CsvLocation = {
	id: string
	name: string
	slug: string
	phone: string | null
	isActive: boolean
	/** Names of the tags the location carries. */
	tags: string[]
}

export function buildLocationsCsv(locations: readonly CsvLocation[]): string {
	return toCsv(
		LOCATIONS_CSV_COLUMNS,
		locations.map((location) => [
			location.id,
			location.name,
			location.slug,
			location.phone ?? '',
			location.isActive ? 'yes' : 'no',
			[...location.tags].sort((a, b) => a.localeCompare(b)).join('; '),
		]),
		{ bom: true },
	)
}

export type CsvProblemCode =
	| 'unknown_location'
	| 'duplicate_row'
	| 'bad_active'
	| 'bad_phone'
	| 'bad_tag'
	| 'tag_too_long'
	| 'too_many_tags'

export type CsvRowProblem = {
	/** 1-based row in the file, header included, as a spreadsheet shows it. */
	row: number
	id: string
	problem: CsvProblemCode
	column?: LocationsCsvColumn
	/** For tag problems: the offending tag text. */
	value?: string
}

export type CsvLocationChange = {
	row: number
	locationId: string
	name: string
	fields: Array<'phone' | 'active' | 'tags'>
	write: {
		phone?: string | null
		isActive?: boolean
		/** Tag names (as written) the location should carry after the upload. */
		tags?: string[]
	}
}

export type LocationsCsvPlan =
	| {
			ok: false
			error: 'empty' | 'not_template' | 'too_many_rows' | 'tag_limit'
	  }
	| {
			ok: true
			rows: number
			changes: CsvLocationChange[]
			problems: CsvRowProblem[]
			/** Tag names the upload would create, in first-seen order. */
			newTags: string[]
	  }

function cell(value: string | undefined): string {
	// A cell exported as `'=…` (formula guard) reads back without the guard.
	return (value ?? '').trim().replace(/^'/, '').trim()
}

const PHONE = /^[0-9+()\-.\s]+$/

/** Splits the tags cell on `;` or `|` (a comma stays inside a name). */
export function parseTagsCell(text: string): string[] {
	return text
		.split(/[;|]/)
		.map((part) => part.replace(/\s+/g, ' ').trim())
		.filter((part) => part.length > 0)
}

/**
 * Reads an uploaded file against the current locations and tags. Never writes:
 * the caller applies `changes` (and creates `newTags`) only when `problems` is
 * empty.
 */
export function planLocationsCsv(
	text: string,
	locations: ReadonlyMap<string, CsvLocation>,
	existingTagNames: readonly string[],
): LocationsCsvPlan {
	const rows = parseDelimited(text)
	if (rows.length === 0) return { ok: false, error: 'empty' }
	const header = rows[0]!.map((value) =>
		cell(value).toLowerCase().replace(/[\s-]+/g, '_'),
	)
	const known = new Set<string>(LOCATIONS_CSV_COLUMNS)
	const named = header.filter(Boolean)
	if (
		!header.includes('id') ||
		named.some((name) => !known.has(name)) ||
		new Set(named).size !== named.length
	) {
		return { ok: false, error: 'not_template' }
	}
	if (rows.length - 1 > LOCATIONS_CSV_MAX_ROWS)
		return { ok: false, error: 'too_many_rows' }
	const column = (name: LocationsCsvColumn) => header.indexOf(name)

	const existingKeys = new Map(
		existingTagNames.map((name) => [locationTagNameKey(name), name]),
	)
	const changes: CsvLocationChange[] = []
	const problems: CsvRowProblem[] = []
	const seen = new Set<string>()
	const newTags = new Map<string, string>()

	rows.slice(1).forEach((values, index) => {
		const row = index + 2
		const read = (name: LocationsCsvColumn) => {
			const at = column(name)
			return at === -1 ? null : cell(values[at])
		}
		const id = read('id') ?? ''
		const location = locations.get(id)
		if (!location) {
			problems.push({ row, id, problem: 'unknown_location', column: 'id' })
			return
		}
		if (seen.has(id)) {
			problems.push({ row, id, problem: 'duplicate_row', column: 'id' })
			return
		}
		seen.add(id)

		const fields: CsvLocationChange['fields'] = []
		const write: CsvLocationChange['write'] = {}
		let bad = false

		const phone = read('phone')
		if (phone !== null && phone !== (location.phone ?? '')) {
			if (
				phone.length > LOCATION_PHONE_MAX_LENGTH ||
				(phone !== '' && !PHONE.test(phone))
			) {
				problems.push({ row, id, problem: 'bad_phone', column: 'phone' })
				bad = true
			} else {
				write.phone = phone === '' ? null : phone
				fields.push('phone')
			}
		}

		const active = read('active')
		if (active !== null && active !== '') {
			const word = active.toLowerCase()
			const value = ['yes', 'true', '1', 'active'].includes(word)
				? true
				: ['no', 'false', '0', 'inactive'].includes(word)
					? false
					: null
			if (value === null) {
				problems.push({ row, id, problem: 'bad_active', column: 'active' })
				bad = true
			} else if (value !== location.isActive) {
				write.isActive = value
				fields.push('active')
			}
		}

		const tagsCell = read('tags')
		if (tagsCell !== null) {
			const wanted: string[] = []
			const keys = new Set<string>()
			for (const raw of parseTagsCell(tagsCell)) {
				if (raw.length > LOCATION_TAG_NAME_MAX_LENGTH) {
					problems.push({
						row,
						id,
						problem: 'tag_too_long',
						column: 'tags',
						value: raw.slice(0, 20),
					})
					bad = true
					continue
				}
				const validated = validateLocationTagName(raw)
				if (!validated.ok) {
					problems.push({ row, id, problem: 'bad_tag', column: 'tags', value: raw })
					bad = true
					continue
				}
				if (keys.has(validated.key)) continue
				keys.add(validated.key)
				// An existing tag keeps the spelling it has.
				wanted.push(existingKeys.get(validated.key) ?? validated.name)
				if (!existingKeys.has(validated.key) && !newTags.has(validated.key)) {
					newTags.set(validated.key, validated.name)
				}
			}
			const current = new Set(location.tags.map(locationTagNameKey))
			const same =
				current.size === keys.size && [...keys].every((key) => current.has(key))
			if (!bad && !same) {
				write.tags = wanted
				fields.push('tags')
			}
		}

		if (!bad && fields.length > 0) {
			changes.push({ row, locationId: id, name: location.name, fields, write })
		}
	})

	// Tags the file would create must fit under the organization limit.
	if (existingKeys.size + newTags.size > MAX_LOCATION_TAGS) {
		return { ok: false, error: 'tag_limit' }
	}
	return {
		ok: true,
		rows: rows.length - 1,
		changes,
		problems,
		newTags: [...newTags.values()],
	}
}
