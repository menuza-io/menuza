import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every discounts loader and action awaits `requireDiscountsAccess` before
 * any other await, so a flag that is off or a missing grant answers before
 * any work happens. The token route is included: it mints the browser-direct
 * usage credential.
 */

const APP_DIR = path.resolve(import.meta.dirname, '../..')
const DISCOUNT_ROUTES_DIR = path.join(
	APP_DIR,
	'routes/_app+/$orgSlug_+/discounts+',
)
const TOKEN_ROUTE = path.join(
	APP_DIR,
	'routes/_app+/$orgSlug_+/discounts-token.ts',
)

const GUARD_CALL = /\brequireDiscountsAccess\(/

const DISCOUNT_ROUTES = ['_index.tsx', 'new.tsx', '$discountId.tsx']

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

describe('discounts guards', () => {
	for (const file of DISCOUNT_ROUTES) {
		const source = read(path.join(DISCOUNT_ROUTES_DIR, file))
		for (const name of ['loader', 'action']) {
			it(`${file}: ${name} calls the guard before anything else is awaited`, () => {
				const body = exportedFunctionBody(source, name)
				expect(body, 'missing export').not.toBeNull()
				const guard = body!.search(GUARD_CALL)
				expect(guard, 'no guard call').toBeGreaterThanOrEqual(0)
				const firstAwait = body!.indexOf('await ')
				expect(firstAwait).toBeGreaterThanOrEqual(0)
				expect(body!.slice(firstAwait, firstAwait + 80)).toMatch(GUARD_CALL)
				const beforeGuard = body!.slice(0, guard)
				expect(beforeGuard).not.toMatch(/request\.(formData|json|text)\(/)
				expect(beforeGuard).not.toMatch(/\bdb\b/)
			})
		}
		it(`${file}: action requests write access`, () => {
			const body = exportedFunctionBody(source, 'action')
			expect(body, 'missing action').not.toBeNull()
			expect(body).toMatch(/requireDiscountsAccess\([^)]*\{[^}]*write:\s*true/s)
		})
	}

	it('the token route guards before it mints a token', () => {
		const source = read(TOKEN_ROUTE)
		const body = exportedFunctionBody(source, 'loader')
		expect(body, 'no loader').not.toBeNull()
		const guard = body!.search(GUARD_CALL)
		expect(guard, 'no guard call').toBeGreaterThanOrEqual(0)
		const firstAwait = body!.indexOf('await ')
		expect(body!.slice(firstAwait, firstAwait + 80)).toMatch(GUARD_CALL)
		expect(body).toMatch(/\bmintDiscountToken\(/)
		expect(body).toMatch(/\bisImpersonating\(request\)/)
	})
})
