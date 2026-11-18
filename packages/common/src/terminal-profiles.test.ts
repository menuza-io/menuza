import { describe, expect, it } from 'vitest'
import {
	DEFAULT_TERMINAL_SETTINGS,
	explicitTerminalJsonSettings,
	inheritedPatch,
	overridesAfter,
	parseGuestDisplayImageUrl,
	parseOverrides,
	parseTerminalJsonSettings,
	terminalSettingsSchema,
} from './terminal-profiles.ts'

const profile = { ...DEFAULT_TERMINAL_SETTINGS, idleLockSeconds: 300 }

describe('terminal profiles', () => {
	it('accepts the defaults and refuses unknown keys and out-of-range values', () => {
		expect(
			terminalSettingsSchema.safeParse(DEFAULT_TERMINAL_SETTINGS).success,
		).toBe(true)
		expect(
			terminalSettingsSchema.safeParse({ ...DEFAULT_TERMINAL_SETTINGS, x: 1 })
				.success,
		).toBe(false)
		expect(
			terminalSettingsSchema.safeParse({
				...DEFAULT_TERMINAL_SETTINGS,
				idleLockSeconds: 7,
			}).success,
		).toBe(false)
		expect(
			terminalSettingsSchema.safeParse({
				...DEFAULT_TERMINAL_SETTINGS,
				dayStartMinutes: 900,
			}).success,
		).toBe(false)
	})

	it('accepts only plain https image addresses for the guest screen', () => {
		expect(parseGuestDisplayImageUrl('https://cdn.test/a.png')).toBe(
			'https://cdn.test/a.png',
		)
		for (const bad of [
			'http://cdn.test/a.png',
			'javascript:alert(1)',
			'data:image/png;base64,AAAA',
			'https://user:pw@cdn.test/a.png',
			'',
			'not a url',
			`https://cdn.test/${'a'.repeat(600)}`,
		])
			expect(parseGuestDisplayImageUrl(bad)).toBeNull()
	})

	it('marks a changed value as an override and a value set back as inherited', () => {
		let overrides = overridesAfter(profile, [], { idleLockSeconds: 600 })
		expect(overrides).toEqual(['idleLockSeconds'])
		overrides = overridesAfter(profile, overrides, { menuDensity: 'compact' })
		expect(overrides).toEqual(['idleLockSeconds', 'menuDensity'])
		overrides = overridesAfter(profile, overrides, { idleLockSeconds: 300 })
		expect(overrides).toEqual(['menuDensity'])
	})

	it('writes the profile value only to keys the terminal does not override', () => {
		const current = { ...DEFAULT_TERMINAL_SETTINGS, idleLockSeconds: 600 }
		const next = {
			...profile,
			idleLockSeconds: 30,
			shiftsRequired: true,
		}
		expect(inheritedPatch(next, current, ['idleLockSeconds'])).toEqual({
			shiftsRequired: true,
		})
		expect(inheritedPatch(next, current, [])).toEqual({
			shiftsRequired: true,
			idleLockSeconds: 30,
		})
	})

	it('treats a setting the terminal never stored as different, even when it equals the default', () => {
		const stored = { signInRequired: false }
		const patch = inheritedPatch(DEFAULT_TERMINAL_SETTINGS, stored, [])
		expect(patch.idleLockSeconds).toBe(120)
	})

	it('reads damaged stored values as the defaults, field by field', () => {
		expect(explicitTerminalJsonSettings('not json')).toEqual({})
		expect(
			explicitTerminalJsonSettings(
				'{"idleLockSeconds":7,"menuDensity":"compact"}',
			),
		).toEqual({ menuDensity: 'compact' })
		expect(parseTerminalJsonSettings('{}')).toMatchObject({
			idleLockSeconds: 120,
			menuColumns: 'auto',
		})
		expect(parseOverrides('["menuDensity","bogus",3]')).toEqual(['menuDensity'])
		expect(parseOverrides('nope')).toEqual([])
	})
})
