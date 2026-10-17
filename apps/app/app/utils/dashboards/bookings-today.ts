import { type BlockType, type DashboardBlock } from './config.ts'

export const BOOKINGS_TODAY_BLOCK_TYPE =
	'bookings-today' as const satisfies BlockType

export type BookingsTodayLocation = {
	id: string
	name: string
}

/**
 * Whether the viewer may see the Bookings today block and which locations it
 * can read. Control-plane facts only: the block's data comes from tenant-api.
 */
export type BookingsTodayAccess = {
	available: boolean
	locations: BookingsTodayLocation[]
}

export const NO_BOOKINGS_TODAY_ACCESS: BookingsTodayAccess = {
	available: false,
	locations: [],
}

/** Ids of Bookings today blocks that stay saved but are not shown to this viewer. */
export function inaccessibleBlockIds(
	blocks: readonly DashboardBlock[],
	access: Pick<BookingsTodayAccess, 'available'>,
): string[] {
	if (access.available) return []
	return blocks
		.filter((block) => block.type === BOOKINGS_TODAY_BLOCK_TYPE)
		.map((block) => block.id)
}
