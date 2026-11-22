export const MENU_FLAG_KEYS = {
	history: 'menu.history',
	bulkEdit: 'menu.bulk_edit',
	/** #92 structure cards in the review stack (default off). */
	structureSuggestions: 'menu.structure_suggestions',
	/** #97 daily auto-popular badges (default off). */
	autoPopular: 'menu.auto_popular',
	/** #73 AI menu import (default off). */
	import: 'menu.import',
	/** #148 guest dish photos & moderation (default off; forced off for KSA). */
	guestPhotos: 'menu.guest_photos',
	/** #192 dish photo A/B tests (default off). */
	photoTests: 'menu.photo_tests',
} as const

export type MenuFlagName = keyof typeof MENU_FLAG_KEYS

const TRUE = new Set(['true', '1', 'on', 'yes'])

/** Only a literal true-like value turns a menu feature flag on. */
export function isMenuFlagOn(value: unknown): boolean {
	if (value === true) return true
	if (typeof value === 'string') return TRUE.has(value.trim().toLowerCase())
	return false
}
