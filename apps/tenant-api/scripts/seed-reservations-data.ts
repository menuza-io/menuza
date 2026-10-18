import {
	type RsvTagCategory,
	type RsvTagScope,
	type RsvTagSystemKey,
} from '@repo/tenant-db'

/**
 * Static demo data for `seed-reservations.ts` that writes enum-typed columns.
 * Kept in its own module so a unit test can check every value against the
 * `RSV_*_VALUES` constants without touching a database.
 */

export type DemoTag = {
	id: string
	scope: RsvTagScope
	category: RsvTagCategory
	name: string
	/** Only the four built-in keys exist; custom tags have none. */
	systemKey: RsvTagSystemKey | null
	/** A `@repo/ui/position-color` key, never a raw color. */
	colorToken: string
	sensitive: boolean
	guestSelectable: boolean
}

export function buildDemoTags(prefix: string): DemoTag[] {
	return [
		{
			id: `tag_${prefix}_vip`,
			scope: 'guest',
			category: 'vip',
			name: 'VIP',
			systemKey: null,
			colorToken: 'amber',
			sensitive: false,
			guestSelectable: false,
		},
		{
			id: `tag_${prefix}_regular`,
			scope: 'guest',
			category: 'regular',
			name: 'Regular',
			systemKey: null,
			colorToken: 'green',
			sensitive: false,
			guestSelectable: false,
		},
		{
			id: `tag_${prefix}_birthday`,
			scope: 'reservation',
			category: 'occasion',
			name: 'Birthday',
			systemKey: 'birthday',
			colorToken: 'pink',
			sensitive: false,
			guestSelectable: true,
		},
		{
			id: `tag_${prefix}_anniversary`,
			scope: 'reservation',
			category: 'occasion',
			name: 'Anniversary',
			systemKey: 'anniversary',
			colorToken: 'violet',
			sensitive: false,
			guestSelectable: true,
		},
		{
			id: `tag_${prefix}_allergy`,
			scope: 'reservation',
			category: 'dietary',
			name: 'Allergy',
			systemKey: null,
			colorToken: 'red',
			sensitive: true,
			guestSelectable: true,
		},
	]
}
