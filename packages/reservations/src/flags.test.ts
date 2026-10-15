import { describe, expect, it } from 'vitest'
import {
	DEFAULT_PLATFORM_FEE_BP,
	MAX_PLATFORM_FEE_BP,
	PLATFORM_FEE_FLAG_KEY,
	RESERVATIONS_CHILD_FEATURES,
	RESERVATIONS_FLAG_KEY_LIST,
	RESERVATIONS_FLAG_KEYS,
	RESERVATIONS_FLAGS,
	foldReservationsFeatures,
	isFlagOn,
	parsePlatformFeeBp,
} from './flags.ts'

describe('reservations flags', () => {
	it('exports all 6 reservations flag keys and platform fee key', () => {
		expect(RESERVATIONS_FLAG_KEYS).toEqual({
			enabled: 'reservations.enabled',
			online: 'reservations.online',
			waitlist: 'reservations.waitlist',
			payments: 'reservations.payments',
			experiences: 'reservations.experiences',
			voice: 'reservations.voice',
		})
		expect(RESERVATIONS_FLAGS).toBe(RESERVATIONS_FLAG_KEYS)
		expect(RESERVATIONS_FLAG_KEY_LIST).toHaveLength(6)
		expect(RESERVATIONS_CHILD_FEATURES).toEqual([
			'online',
			'waitlist',
			'payments',
			'experiences',
			'voice',
		])
		expect(PLATFORM_FEE_FLAG_KEY).toBe('reservations.platform_fee_bp')
	})

	it('only treats literal boolean true as on', () => {
		expect(isFlagOn(true)).toBe(true)
		expect(isFlagOn(false)).toBe(false)
		expect(isFlagOn('true')).toBe(false)
		expect(isFlagOn(1)).toBe(false)
		expect(isFlagOn(null)).toBe(false)
		expect(isFlagOn(undefined)).toBe(false)
		expect(isFlagOn({})).toBe(false)
	})

	it('folds child flags to false whenever reservations.enabled is not literal true', () => {
		expect(
			foldReservationsFeatures({
				enabled: false,
				online: true,
				waitlist: true,
				payments: true,
				experiences: true,
				voice: true,
			}),
		).toEqual({
			enabled: false,
			online: false,
			waitlist: false,
			payments: false,
			experiences: false,
			voice: false,
		})

		expect(
			foldReservationsFeatures({
				'reservations.enabled': 'true',
				'reservations.online': true,
			}),
		).toEqual({
			enabled: false,
			online: false,
			waitlist: false,
			payments: false,
			experiences: false,
			voice: false,
		})
	})

	it('folds child flags accurately when reservations.enabled is true (both short and full keys)', () => {
		expect(
			foldReservationsFeatures({
				enabled: true,
				online: true,
				waitlist: 'true',
				payments: true,
				experiences: false,
				voice: 1,
			}),
		).toEqual({
			enabled: true,
			online: true,
			waitlist: false,
			payments: true,
			experiences: false,
			voice: false,
		})

		expect(
			foldReservationsFeatures({
				'reservations.enabled': true,
				'reservations.online': true,
				'reservations.waitlist': true,
				'reservations.payments': false,
				'reservations.experiences': true,
				'reservations.voice': true,
			}),
		).toEqual({
			enabled: true,
			online: true,
			waitlist: true,
			payments: false,
			experiences: true,
			voice: true,
		})
	})

	it('parses platform fee basis points in 0..10000 and rejects non-integers or out-of-range values', () => {
		expect(DEFAULT_PLATFORM_FEE_BP).toBe(0)
		expect(MAX_PLATFORM_FEE_BP).toBe(10_000)

		expect(parsePlatformFeeBp(undefined)).toBe(0)
		expect(parsePlatformFeeBp(null)).toBe(0)
		expect(parsePlatformFeeBp('')).toBe(0)
		expect(parsePlatformFeeBp(0)).toBe(0)
		expect(parsePlatformFeeBp(250)).toBe(250)
		expect(parsePlatformFeeBp('500')).toBe(500)
		expect(parsePlatformFeeBp(10_000)).toBe(10_000)

		const warnings: string[] = []
		const warn = (msg: string) => warnings.push(msg)

		expect(parsePlatformFeeBp(-1, warn)).toBe(0)
		expect(parsePlatformFeeBp(10_001, warn)).toBe(0)
		expect(parsePlatformFeeBp(12.5, warn)).toBe(0)
		expect(parsePlatformFeeBp('12.5', warn)).toBe(0)
		expect(parsePlatformFeeBp('abc', warn)).toBe(0)
		expect(parsePlatformFeeBp(Number.NaN, warn)).toBe(0)
		expect(parsePlatformFeeBp(true, warn)).toBe(0)
		expect(warnings).toHaveLength(7)
	})
})
