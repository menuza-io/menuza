import { afterEach, describe, expect, it, vi } from 'vitest'
import { managedSettingsPatch, type PosSettings } from './config.ts'
import { checkDeviceDetailed } from './outbox.ts'

const base = (over: Partial<PosSettings> = {}): PosSettings =>
	({
		appUrl: 'https://app.test',
		slug: 'joes',
		tenantApiUrl: 'https://api.test',
		terminalCode: 'T1',
		locationId: null,
		locationLocked: false,
		scopeId: 'main',
		signInRequired: true,
		dayStartMinutes: 240,
		shiftsRequired: false,
		idleLockSeconds: 120,
		deviceToken: 'tok',
		deviceLabel: 'Counter',
		demo: false,
		locale: null,
		menuColumns: 'auto',
		menuDensity: 'comfortable',
		apps: {
			timeclock: false,
			reservations: false,
			inventory: false,
			orders: false,
		},
		activeApp: 'pos',
		...over,
	}) as PosSettings

describe('managedSettingsPatch', () => {
	it('takes the server value for the lock timeout and the menu layout, and remembers what is managed', () => {
		const next = managedSettingsPatch(
			base({ idleLockSeconds: 300, menuColumns: 4 }),
			{ idleLockSeconds: 30, menuDensity: 'compact', kdsStationId: 'bar' },
			'Counter',
		)
		expect(next).toMatchObject({
			idleLockSeconds: 30,
			menuColumns: 4, // not managed: the till keeps its own
			menuDensity: 'compact',
			managed: {
				idleLockSeconds: 30,
				menuDensity: 'compact',
				kdsStationId: 'bar',
			},
			profileName: 'Counter',
		})
	})

	it('changes nothing when the server says what the till already has', () => {
		const current = base({
			idleLockSeconds: 30,
			managed: { idleLockSeconds: 30 },
			profileName: 'Counter',
		})
		expect(
			managedSettingsPatch(current, { idleLockSeconds: 30 }, 'Counter'),
		).toBeNull()
	})

	it('keeps the last value as the till’s own when the server stops managing a setting', () => {
		const current = base({
			idleLockSeconds: 30,
			managed: { idleLockSeconds: 30 },
		})
		const next = managedSettingsPatch(current, {}, null)
		expect(next).toMatchObject({
			idleLockSeconds: 30,
			managed: {},
			profileName: null,
		})
	})
})

describe('checkDeviceDetailed', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('reports only the settings the server stored, and the profile name', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({
					device: {
						signInRequired: true,
						scopeId: 'main',
						idleLockSeconds: 600,
						kdsStationId: 'bar',
					},
					profile: { id: 'p1', name: 'Bar tablet' },
					apps: {},
				}),
			),
		)
		const result = await checkDeviceDetailed(base())
		expect(result.managed).toEqual({
			idleLockSeconds: 600,
			kdsStationId: 'bar',
		})
		expect(result.profileName).toBe('Bar tablet')
	})

	it('an older node that sends no settings leaves everything to the till', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({ device: { signInRequired: true, scopeId: 'main' } }),
			),
		)
		const result = await checkDeviceDetailed(base())
		expect(result.managed).toEqual({})
		expect(result.profileName).toBeNull()
	})
})
