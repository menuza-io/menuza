import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => readFileSync(path.join(APP, rel), 'utf8')

/** Each write that feeds the ReservationsContext must notify the regional node. */
const CASES: Array<[file: string, reason: string, min: number]> = [
	['utils/shop.server.ts', 'payments', 7],
	['utils/payments-mock/onboard.server.ts', 'payments', 5],
	['routes/_app+/$orgSlug_+/settings+/_index.tsx', 'branding', 1],
	['routes/_app+/$orgSlug_+/staff+/timeclock.rules.tsx', 'staffing', 1],
	['routes/_app+/$orgSlug_+/website+/_index.tsx', 'branding', 4],
	['routes/_app+/$orgSlug_+/website+/pages.$pageId.tsx', 'branding', 6],
]

describe('reservations context notify call sites', () => {
	for (const [file, reason, min] of CASES) {
		it(`${file} notifies with '${reason}' at least ${min}x`, () => {
			const source = read(file)
			const calls = source.match(
				new RegExp(
					`notifyReservationsContextChanged\\([^)]*'${reason}'\\)`,
					'g',
				),
			)
			expect(calls?.length ?? 0).toBeGreaterThanOrEqual(min)
		})
	}
})
