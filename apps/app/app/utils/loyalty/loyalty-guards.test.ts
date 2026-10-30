import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The App side of the loyalty security sweep. Reads the route sources and
 * fails when a loyalty loader or action can run before the guard:
 *
 *  - every `loader` and `action` under `loyalty+/` calls
 *    `requireLoyaltyAccess` before anything else is awaited, so a flag that
 *    is off or a missing grant answers before any work happens;
 *  - the token route guards with `requireLoyaltyAccess` and refuses
 *    impersonation write scopes through the claims contract;
 *  - the internal context resource route authenticates with
 *    `requireInternalCommandAuth` before it touches the database.
 */

const APP_DIR = path.resolve(import.meta.dirname, '../..')
const LOYALTY_ROUTES = path.join(APP_DIR, 'routes/_app+/$orgSlug_+/loyalty+')
const RESOURCES = path.join(APP_DIR, 'routes/resources+')

const GUARD_CALL = /\brequireLoyaltyAccess\(/

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

describe('loyalty guards: loyalty+ loaders and actions', () => {
	const files = sourceFiles(LOYALTY_ROUTES, /\.tsx?$/)

	it('finds all loyalty routes', () => {
		for (const required of [
			'token.ts',
			'_layout.tsx',
			'_index.tsx',
			'overview.tsx',
			'program.tsx',
			'rewards.tsx',
			'activity.tsx',
		]) {
			expect(files).toContain(required)
		}
	})

	for (const file of files) {
		const source = read(path.join(LOYALTY_ROUTES, file))
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

	it('the token route mints scoped tokens and detects impersonation', () => {
		const tokenSource = read(path.join(LOYALTY_ROUTES, 'token.ts'))
		expect(tokenSource).toMatch(/\bloyaltyScopeSchema\b/)
		expect(tokenSource).toMatch(/\bisImpersonating\(request\)/)
		expect(tokenSource).toMatch(/\bmintLoyaltyToken\(/)
	})
})

describe('loyalty guards: Customer profile', () => {
	it('the customer route loader sends capability flags only, never points', () => {
		const source = read(
			path.join(APP_DIR, 'routes/_app+/$orgSlug_+/customers_.$personKey.tsx'),
		)
		const body = exportedFunctionBody(source, 'loader')
		expect(body, 'no loader').not.toBeNull()
		// Flags and grants resolve without throwing; the token mint enforces
		// them again. A customer's balance and history never pass through App.
		expect(body).toMatch(/\bgetLoyaltyCapabilities\(/)
		expect(body).not.toMatch(/\bgetMember\b|\bgetCustomerMember\b|\bfetch\(/)
	})
})

describe('loyalty guards: resource routes', () => {
	it('loyalty.context.ts authenticates before it touches the database', () => {
		const source = read(path.join(RESOURCES, 'loyalty.context.ts'))
		const body = exportedFunctionBody(source, 'loader')
		expect(body, 'no loader').not.toBeNull()
		const guard = body!.search(/\brequireInternalCommandAuth\(/)
		expect(guard, 'no authentication call').toBeGreaterThanOrEqual(0)
		const before = body!.slice(0, guard)
		expect(before).not.toMatch(/\b(db|fetch)\b/)
		// Flags only: the context must never read loyalty member data.
		expect(body).not.toMatch(/loyaltyMembers|loyaltyLedger|loyaltyBalances/)
	})
})
