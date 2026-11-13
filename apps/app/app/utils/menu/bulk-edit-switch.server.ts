/** Kill switch for menu bulk edit (`MENU_BULK_EDIT_ENABLED`). Unset means on. */
export function isMenuBulkEditKillSwitchOn(env: {
	MENU_BULK_EDIT_ENABLED?: string
}): boolean {
	const raw = env.MENU_BULK_EDIT_ENABLED?.trim().toLowerCase()
	if (!raw) return false
	return raw === 'false' || raw === '0' || raw === 'off' || raw === 'no'
}
