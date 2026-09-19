import { describe, expect, it } from 'vitest'

import {
	mapManuzaLocationPermission,
	mapManuzaMenuPermission,
	MENU_READ_PERMISSION,
	MENU_WRITE_PERMISSION,
} from './menu-permissions.server.ts'

describe('menu-permissions.server', () => {
	it('maps menu:read and menu:write to organization permissions', () => {
		expect(mapManuzaMenuPermission('menu:read')).toBe(MENU_READ_PERMISSION)
		expect(mapManuzaMenuPermission('menu:write')).toBe(MENU_WRITE_PERMISSION)
	})

	it('maps locations:read and locations:write', () => {
		expect(mapManuzaLocationPermission('locations:read')).toBe(
			'read:location:any',
		)
		expect(mapManuzaLocationPermission('locations:write')).toBe(
			'update:location:any',
		)
	})
})
