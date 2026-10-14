import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The App side of the staffing security sweep (the tenant-api side is
 * `apps/tenant-api/src/routes/staffing-security.test.ts`). It reads the route
 * sources and fails when a staff loader or action can run before the guard:
 *
 *  - every `loader` and `action` under `staff+/` calls `requireStaffingAccess`
 *    (directly, or through one of the access wrappers that themselves call it)
 *    before anything else is awaited, so a flag that is off or a missing grant
 *    answers before any work happens;
 *  - every staffing resource route authenticates a signed-in member with the
 *    permission, or an internal command token;
 *  - the credential-less routes are an explicit list, each with its reason.
 */

const APP_DIR = path.resolve(import.meta.dirname, '../..')
const STAFF_ROUTES = path.join(APP_DIR, 'routes/_app+/$orgSlug_+/staff+')
const RESOURCES = path.join(APP_DIR, 'routes/resources+')
const STAFFING_UTILS = path.join(APP_DIR, 'utils/staffing')

/** Wrappers that call `requireStaffingAccess` first (verified below). */
const WRAPPERS = [
	'requireStaffingAccess',
	'requireLaborAccess',
	'requireScheduleAccess',
	'requireTimesheetsAccess',
	'requirePostingWriter',
	// Delegates to `requirePostingWriter` as its first statement (verified below).
	'runPostingAction',
]
const GUARD_CALL = new RegExp(`\\b(${WRAPPERS.join('|')})\\(`)

function read(file: string) {
	return fs.readFileSync(file, 'utf8')
}

/** The text of `export [async] function <name>(...) { ... }`, or null. */
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

describe('staffing guards: access wrappers', () => {
	for (const file of [
		'labor-access.server.ts',
		'schedule-access.server.ts',
		'timesheets-access.server.ts',
	]) {
		it(`${file} calls requireStaffingAccess`, () => {
			expect(read(path.join(STAFFING_UTILS, file))).toMatch(
				/\brequireStaffingAccess\(/,
			)
		})
	}
})

describe('staffing guards: the job posting action helper', () => {
	const source = read(
		path.join(APP_DIR, 'utils/hiring/posting-actions.server.ts'),
	)

	it('requirePostingWriter awaits requireStaffingAccess first', () => {
		const body = exportedFunctionBody(source, 'requirePostingWriter')!
		expect(
			body.slice(body.indexOf('await '), body.indexOf('await ') + 60),
		).toMatch(/requireStaffingAccess\(/)
	})

	it('runPostingAction awaits requirePostingWriter before it reads the form', () => {
		const body = exportedFunctionBody(source, 'runPostingAction')!
		const guard = body.indexOf('requirePostingWriter(')
		expect(guard).toBeGreaterThanOrEqual(0)
		expect(body.indexOf('request.formData')).toBeGreaterThan(guard)
		expect(body.slice(0, guard)).not.toMatch(/\bdb\b/)
	})
})

describe('staffing guards: staff+ loaders and actions', () => {
	const files = sourceFiles(STAFF_ROUTES, /\.tsx?$/)

	it('finds the staff routes', () => {
		expect(files.length).toBeGreaterThan(20)
	})

	for (const file of files) {
		const source = read(path.join(STAFF_ROUTES, file))
		for (const name of ['loader', 'action']) {
			const body = exportedFunctionBody(source, name)
			if (body === null) continue
			it(`${file}: ${name} calls the guard before anything else is awaited`, () => {
				const guard = body.search(GUARD_CALL)
				expect(guard, 'no guard call').toBeGreaterThanOrEqual(0)
				const firstAwait = body.indexOf('await ')
				// The guard is the first awaited call (`await requireX(` or
				// `const access = await requireX(`), or the whole body hands off to
				// a verified helper (`return runPostingAction(`).
				const handsOff = /^\s*return (await )?runPostingAction\(/.test(body)
				if (!handsOff) {
					expect(firstAwait).toBeGreaterThanOrEqual(0)
					expect(body.slice(firstAwait, firstAwait + 120)).toMatch(GUARD_CALL)
				}
				// Nothing reads the request body or params into a query first.
				const beforeGuard = body.slice(0, guard)
				expect(beforeGuard).not.toMatch(/request\.(formData|json|text)\(/)
			})
		}
		it(`${file}: has no unguarded data function`, () => {
			// A route module must not export other server entry points.
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
})

describe('staffing guards: resource routes', () => {
	const files = sourceFiles(
		RESOURCES,
		/^(staffing\.|jobs\.(staffing|job-posting))/,
	)

	it('finds the staffing resource routes', () => {
		expect(files.length).toBeGreaterThanOrEqual(6)
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
				const guard = internal >= 0 ? internal : member
				expect(guard, 'no authentication call').toBeGreaterThanOrEqual(0)
				const firstAwait = body.indexOf('await ')
				expect(firstAwait).toBeGreaterThanOrEqual(0)
				// Reading the user (for a member route) may come first; anything
				// that touches data may not.
				const before = body.slice(firstAwait, guard)
				expect(before).not.toMatch(/\b(db|tenantFetch|fetch)\b/)
			}
		})
	}
})

describe('staffing guards: routes without a login, on purpose', () => {
	/** Each entry says why it needs no member login and what protects it. */
	const PUBLIC_ROUTES: Record<string, string> = {
		'routes/kiosk.tsx':
			'static shell; the paired device secret is checked by tenant-api',
		'routes/kiosk._index.tsx':
			'static shell; PIN and device secret live in tenant-api',
		'routes/kiosk.pair.tsx':
			'pairing code redeemed directly against tenant-api',
		'routes/my-schedule.tsx':
			'static shell; the link token is checked by tenant-api',
		'routes/resources+/sites.careers.ts':
			'public job feed; 404 unless the site is published and staffing.hiring is on',
	}

	for (const [relative, reason] of Object.entries(PUBLIC_ROUTES)) {
		it(`${relative} exists and reads no organization data without a flag check (${reason})`, () => {
			const file = path.join(APP_DIR, relative)
			expect(fs.existsSync(file)).toBe(true)
			const source = read(file)
			// None of them touch member-only data helpers.
			expect(source).not.toMatch(/getUserOrganizationPermissions\(/)
			// Anything that reads the control plane checks the feature flag.
			if (/\bdb\./.test(source)) {
				expect(source).toMatch(/isStaffingFeatureEnabled\(/)
			}
		})
	}

	it('no other kiosk or public staffing page appears unlisted', () => {
		const top = fs
			.readdirSync(path.join(APP_DIR, 'routes'))
			.filter((file) => /^(kiosk|my-schedule)/.test(file))
			.map((file) => `routes/${file}`)
			.filter((file) => !/\.test\.tsx?$/.test(file))
		expect(top.filter((file) => !(file in PUBLIC_ROUTES)).sort()).toEqual([])
	})
})
