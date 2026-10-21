import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
	RSV_ACTOR_KIND_VALUES,
	RSV_EXPERIENCE_KIND_VALUES,
	RSV_EXPERIENCE_STATUS_VALUES,
	RSV_OCCUPANCY_KIND_VALUES,
	RSV_PACING_CHANNEL_VALUES,
	RSV_RESERVATION_CHANNEL_VALUES,
	RSV_RESERVATION_STATUS_VALUES,
	RSV_TABLE_SHAPE_VALUES,
	RSV_TAG_CATEGORY_VALUES,
	RSV_TAG_SCOPE_VALUES,
	RSV_TAG_SYSTEM_KEY_VALUES,
	RSV_WAITLIST_CHANNEL_VALUES,
	RSV_WAITLIST_STATUS_VALUES,
} from '@repo/tenant-db'
import { describe, expect, it } from 'vitest'
import { buildDemoTags } from './seed-reservations-data.ts'

const source = readFileSync(
	path.join(import.meta.dirname, 'seed-reservations.ts'),
	'utf8',
)
const literals = (key: string, suffix = '') =>
	[...source.matchAll(new RegExp(`\\b${key}: '([a-z_]+)'${suffix}`, 'g'))].map(
		(m) => m[1]!,
	)

describe('seed-reservations enum values', () => {
	it('writes valid tag scopes, categories, system keys and unique keys', () => {
		const tags = buildDemoTags('x')
		for (const tag of tags) {
			expect(RSV_TAG_SCOPE_VALUES).toContain(tag.scope)
			expect(RSV_TAG_CATEGORY_VALUES).toContain(tag.category)
			if (tag.systemKey)
				expect(RSV_TAG_SYSTEM_KEY_VALUES).toContain(tag.systemKey)
		}
		const keys = tags.map((t) => t.systemKey).filter(Boolean)
		expect(new Set(keys).size).toBe(keys.length)
	})

	it('uses valid reservation statuses, shapes and channels in the seed source', () => {
		const statuses = literals('status', ' as const')
		expect(statuses.length).toBeGreaterThan(3)
		for (const v of statuses)
			expect(RSV_RESERVATION_STATUS_VALUES as readonly string[]).toContain(v)
		const shapes = literals('shape', ' as const')
		expect(shapes.length).toBeGreaterThan(3)
		for (const v of shapes)
			expect(RSV_TABLE_SHAPE_VALUES as readonly string[]).toContain(v)
		expect(RSV_RESERVATION_CHANNEL_VALUES as readonly string[]).toContain(
			literals('channel').find((c) => c === 'host'),
		)
	})

	it('uses valid values for every other enum column it writes', () => {
		const has = (list: readonly string[], v: string) => {
			expect(list).toContain(v)
		}
		for (const v of literals('kind')) {
			if (v === 'reservation') has(RSV_OCCUPANCY_KIND_VALUES, v)
			else has(RSV_EXPERIENCE_KIND_VALUES, v)
		}
		for (const v of [...literals('actorKind'), ...literals('createdByKind')])
			has(RSV_ACTOR_KIND_VALUES, v)
		has(RSV_WAITLIST_CHANNEL_VALUES, 'walk_in')
		has(RSV_WAITLIST_STATUS_VALUES, 'waiting')
		has(RSV_PACING_CHANNEL_VALUES, 'all')
		has(RSV_EXPERIENCE_STATUS_VALUES, 'published')
		// Source-level guard: these were the values the seed once got wrong.
		expect(source).not.toMatch(/kind: 'tasting'/)
		expect(source).not.toMatch(/scope: 'visit'/)
	})
})
