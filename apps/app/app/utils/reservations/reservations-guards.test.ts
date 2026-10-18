import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The App side of the reservations security sweep (`VAL-FND-020`).
 * Reads the route sources and fails when a reservations loader or action can
 * run before the guard:
 *
 *  - every `loader` and `action` under `reservations+/` calls
 *    `requireReservationsAccess` before anything else is awaited, so a flag
 *    that is off or a missing grant answers before any work happens;
 *  - every reservations resource route in `routes/resources+/reservations.*.ts`
 *    authenticates with `requireInternalCommandAuth`,
 *    `requireUserWithOrganizationPermission` or `requireReservationsAccess`
 *    first;
 *  - the payment routes (`sites.reservation.*`, `jobs.reservation-payments-*`)
 *    authenticate with `requireInternalCommandAuth` before anything else.
 */

const APP_DIR = path.resolve(import.meta.dirname, '../..')
const RESERVATIONS_ROUTES = path.join(
	APP_DIR,
	'routes/_app+/$orgSlug_+/reservations+',
)
const RESOURCES = path.join(APP_DIR, 'routes/resources+')

const WRAPPERS = ['requireReservationsAccess']
const GUARD_CALL = new RegExp(`\\b(${WRAPPERS.join('|')})\\(`)

const RESERVATIONS_SECTIONS_SOURCE = fs.readFileSync(
	path.resolve(import.meta.dirname, 'sections.ts'),
	'utf8',
)

function read(file: string) {
	return fs.readFileSync(file, 'utf8')
}

function exportedFunctionBody(source: string, name: string): string | null {
	const start = source.search(
		new RegExp(`export (async )?function ${name}\\s*\\(`),
	)
	if (start === -1) return null
	const open = source.indexOf('{', source.indexOf(')', start))
	let depth = 0
	for (let index = open; index < source.length; index += 1) {
		const char = source[index]
		if (char === '{') depth += 1
		if (char === '}') {
			depth -= 1
			if (depth === 0) return source.slice(open + 1, index)
		}
	}
	return null
}

function sourceFiles(directory: string, pattern: RegExp) {
	return fs
		.readdirSync(directory)
		.filter((file) => pattern.test(file) && !/\.test\.tsx?$/.test(file))
		.sort()
}

describe('reservations guards: reservations+ loaders and actions (VAL-FND-020)', () => {
	const files = sourceFiles(RESERVATIONS_ROUTES, /\.tsx?$/)

	it('finds all reservations routes including setup and host stand sub-routes', () => {
		expect(files.length).toBeGreaterThanOrEqual(16)
		for (const required of [
			'today.tsx',
			'book.tsx',
			'timeline.tsx',
			'floor.tsx',
			'calendar.tsx',
			'overview.tsx',
			'settings.tsx',
			'settings._index.tsx',
			'settings.tables.tsx',
			'settings.floor-plan.tsx',
			'settings.services.tsx',
			'settings.special-days.tsx',
			'settings.sections.tsx',
			'settings.messages.tsx',
			'settings.waitlist.tsx',
			'settings.policies.tsx',
			'experiences.tsx',
			'experiences.$id.tsx',
			'waitlist.tsx',
			'guests.tsx',
			'guests.$guestId.tsx',
			'reports.tsx',
		]) {
			expect(files).toContain(required)
		}
	})

	for (const file of files) {
		const source = read(path.join(RESERVATIONS_ROUTES, file))
		for (const name of ['loader', 'action']) {
			const body = exportedFunctionBody(source, name)
			if (body === null) continue
			it(`${file}: ${name} calls the guard before anything else is awaited`, () => {
				const guard = body.search(GUARD_CALL)
				expect(guard, 'no guard call').toBeGreaterThanOrEqual(0)
				const firstAwait = body.indexOf('await ')
				expect(firstAwait).toBeGreaterThanOrEqual(0)
				expect(body.slice(firstAwait, firstAwait + 120)).toMatch(GUARD_CALL)
				const beforeGuard = body.slice(0, guard)
				expect(beforeGuard).not.toMatch(/request\.(formData|json|text)\(/)
				expect(beforeGuard).not.toMatch(/\bdb\b/)
			})
		}
		it(`${file}: has no unguarded data function`, () => {
			const exports = [
				...source.matchAll(/export (?:async )?function (\w+)/g),
			].map((match) => match[1]!)
			const entryPoints = exports.filter((name) =>
				['loader', 'action', 'clientLoader', 'clientAction'].includes(name),
			)
			expect(
				entryPoints.every((name) => ['loader', 'action'].includes(name)),
			).toBe(true)
		})
	}
	it('the payment policies and experience routes demand their feature flags (VAL-EXP-013)', () => {
		const policies = read(
			path.join(RESERVATIONS_ROUTES, 'settings.policies.tsx'),
		)
		expect(policies).toMatch(/feature: 'payments'/)
		for (const file of ['experiences.tsx', 'experiences.$id.tsx']) {
			expect(read(path.join(RESERVATIONS_ROUTES, file))).toMatch(
				/RESERVATIONS_SECTION_REQUIREMENTS\.experiences/,
			)
		}
		expect(RESERVATIONS_SECTIONS_SOURCE).toMatch(
			/id: 'experiences'[\s\S]*?feature: 'experiences'/,
		)
	})

	it('the layout header renders the location picker only when locations.length > 1 (VAL-FND-022)', () => {
		const layoutSource = read(
			path.join(APP_DIR, 'components/reservations/header-controls.tsx'),
		)
		expect(read(path.join(RESERVATIONS_ROUTES, '_layout.tsx'))).toMatch(
			/ReservationsHeaderControls/,
		)
		expect(layoutSource).toMatch(
			/locations\.length\s*>\s*1\s*\?[\s\S]*?reservations-location-select/,
		)
	})

	it('settings+/locations.$locationId.tsx checks reservations.enabled and notifies context-changed (VAL-SETUP-022, VAL-CROSS-001)', () => {
		const locationSettingsSource = read(
			path.join(
				APP_DIR,
				'routes/_app+/$orgSlug_+/settings+/locations.$locationId.tsx',
			),
		)
		expect(locationSettingsSource).toMatch(/\bisReservationsFeatureEnabled\(/)
		expect(locationSettingsSource).toMatch(
			/\bnotifyReservationsContextChanged\(/,
		)
	})
})

describe('reservations guards: resource routes (VAL-FND-020)', () => {
	const files = sourceFiles(RESOURCES, /^reservations\./)

	it('finds the reservations resource routes', () => {
		expect(files.length).toBeGreaterThanOrEqual(1)
	})

	for (const file of files) {
		it(`${file} authenticates before it does anything`, () => {
			const source = read(path.join(RESOURCES, file))
			const entries = ['loader', 'action']
				.map((name) => exportedFunctionBody(source, name))
				.filter((body): body is string => body !== null)
			expect(entries.length).toBeGreaterThan(0)
			for (const body of entries) {
				const internal = body.search(/\brequireInternalCommandAuth\(/)
				const member = body.search(/\brequireUserWithOrganizationPermission\(/)
				const access = body.search(/\brequireReservationsAccess\(/)
				const guard =
					[internal, member, access].find((index) => index >= 0) ?? -1
				expect(guard, 'no authentication call').toBeGreaterThanOrEqual(0)
				const firstAwait = body.indexOf('await ')
				expect(firstAwait).toBeGreaterThanOrEqual(0)
				const before = body.slice(firstAwait, guard)
				expect(before).not.toMatch(/\b(db|tenantFetch|fetch)\b/)
			}
		})
	}
})

describe('reservation payment routes: authentication first (VAL-PAY-052)', () => {
	const internalRoutes = [
		'reservations.payments.ts',
		'sites.reservation.checkout.ts',
		'sites.reservation.status.ts',
		'jobs.reservation-payments-reconcile.ts',
	]
	const operatorRoutes = [
		'reservations.payments.fee.ts',
		'reservations.payments.refund.ts',
	]

	for (const file of [...internalRoutes, ...operatorRoutes]) {
		it(`${file} awaits its guard before reading the body or touching data`, () => {
			const source = read(path.join(RESOURCES, file))
			const body = exportedFunctionBody(source, 'action')
			expect(body, 'no action').not.toBeNull()
			// The Sites payment routes use a dedicated, synchronous guard that must
			// run before any await; the others await their guard first.
			const syncGuarded = file.startsWith('sites.reservation.')
			const pattern = operatorRoutes.includes(file)
				? /\brequireReservationsAccess\(/
				: syncGuarded
					? /\brequireSitesReservationPaymentAuth\(/
					: /\brequireInternalCommandAuth\(/
			const guard = body!.search(pattern)
			expect(guard, 'no guard call').toBeGreaterThanOrEqual(0)
			const firstAwait = body!.indexOf('await ')
			if (syncGuarded) {
				expect(firstAwait === -1 || guard < firstAwait).toBe(true)
			} else {
				expect(body!.slice(firstAwait, firstAwait + 80)).toMatch(pattern)
			}
			const before = body!.slice(0, guard)
			expect(before).not.toMatch(/request\.(formData|json|text)\(/)
			expect(before).not.toMatch(/\b(db|fetch)\b/)
		})
	}

	it('the operator routes demand the payments feature and grant and refuse impersonation', () => {
		for (const file of operatorRoutes) {
			const source = read(path.join(RESOURCES, file))
			expect(source).toMatch(/feature: 'payments'/)
			expect(source).toMatch(/UPDATE_RESERVATION_PAYMENT/)
			expect(source).toMatch(/isImpersonating\(request\)/)
		}
	})
})
