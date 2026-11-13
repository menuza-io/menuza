export const MENU_FLAG_KEYS = {
	history: 'menu.history',
	bulkEdit: 'menu.bulk_edit',
} as const

export type MenuFlagName = keyof typeof MENU_FLAG_KEYS

const TRUE = new Set(['true', '1', 'on', 'yes'])

/** Only a literal true-like value turns a menu feature flag on. */
export function isMenuFlagOn(value: unknown): boolean {
	if (value === true) return true
	if (typeof value === 'string') return TRUE.has(value.trim().toLowerCase())
	return false
}
