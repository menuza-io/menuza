import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every inventory loader and action awaits `requireInventoryAccess` before
 * any other await, so a flag that is off or a missing grant answers before
 * any work happens. The token route is included: it mints the browser-direct
 * `inv+jwt`. New route files are picked up automatically.
 */

const APP_DIR = path.resolve(import.meta.dirname, '../..')
const INVENTORY_ROUTES_DIR = path.join(
	APP_DIR,
	'routes/_app+/$orgSlug_+/inventory+',
)
const TOKEN_ROUTE = path.join(
	APP_DIR,
	'routes/_app+/$orgSlug_+/inventory-token.ts',
)

const GUARD_CALL = /\brequireInventoryAccess\(/

const ROUTE_FILES = fs
	.readdirSync(INVENTORY_ROUTES_DIR)
	.filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
	.sort()

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

function expectGuardFirst(body: string) {
	const guard = body.search(GUARD_CALL)
	expect(guard, 'no guard call').toBeGreaterThanOrEqual(0)
	const firstAwait = body.indexOf('await ')
	expect(firstAwait, 'nothing awaited').toBeGreaterThanOrEqual(0)
	expect(body.slice(firstAwait, firstAwait + 80)).toMatch(GUARD_CALL)
	const beforeGuard = body.slice(0, guard)
	expect(beforeGuard).not.toMatch(/request\.(formData|json|text)\(/)
	expect(beforeGuard).not.toMatch(/\bdb\b/)
}

describe('inventory guards', () => {
	it('finds the inventory routes', () => {
		expect(ROUTE_FILES).toEqual(
			expect.arrayContaining([
				'_layout.tsx',
				'_index.tsx',
				'today.tsx',
				'stock.tsx',
				'stock.new.tsx',
				'stock.$itemId.tsx',
				'stock.$itemId_.edit.tsx',
				'stock.add-many.tsx',
				'stock.areas.tsx',
				'stock.lists.tsx',
				'counts.tsx',
				'counts_.$countId.tsx',
				'counts_.$countId_.review.tsx',
				'purchasing.tsx',
				'purchasing.suppliers.new.tsx',
				'purchasing.suppliers.$supplierId.tsx',
				'purchasing.deliveries.$deliveryId.tsx',
				'purchasing_.deliveries.new.tsx',
				'purchasing_.orders.$orderId.tsx',
				'stock.levels.tsx',
				'waste.tsx',
			]),
		)
	})

	it('the sheets that change stock need the update grant, not just the read grant', () => {
		for (const file of [
			'stock.new.tsx',
			'stock.$itemId_.edit.tsx',
			'stock.add-many.tsx',
			'stock.areas.tsx',
			'stock.lists.tsx',
		]) {
			const body = exportedFunctionBody(
				read(path.join(INVENTORY_ROUTES_DIR, file)),
				'loader',
			)
			expect([file, body]).toEqual([
				file,
				expect.stringMatching(/INVENTORY_PERMISSIONS\.UPDATE_INVENTORY\b/),
			])
		}
	})

	it('adding a supplier needs the purchasing grant and recording a delivery the update grant', () => {
		const grantFor = {
			'purchasing.suppliers.new.tsx': /UPDATE_INVENTORY_PURCHASING\b/,
			'purchasing_.deliveries.new.tsx':
				/INVENTORY_PERMISSIONS\.UPDATE_INVENTORY\b/,
		}
		for (const [file, grant] of Object.entries(grantFor)) {
			const body = exportedFunctionBody(
				read(path.join(INVENTORY_ROUTES_DIR, file)),
				'loader',
			)
			expect([file, body]).toEqual([file, expect.stringMatching(grant)])
		}
	})

	it('levels need the purchasing grant, and levels and orders need the purchasing flag', () => {
		const levels = exportedFunctionBody(
			read(path.join(INVENTORY_ROUTES_DIR, 'stock.levels.tsx')),
			'loader',
		)
		expect(levels).toMatch(/UPDATE_INVENTORY_PURCHASING\b/)
		for (const file of [
			'stock.levels.tsx',
			'purchasing_.orders.$orderId.tsx',
		]) {
			const body = exportedFunctionBody(
				read(path.join(INVENTORY_ROUTES_DIR, file)),
				'loader',
			)
			expect([file, body]).toEqual([
				file,
				expect.stringMatching(/features\.purchasing/),
			])
		}
	})

	for (const file of ROUTE_FILES) {
		const source = read(path.join(INVENTORY_ROUTES_DIR, file))
		it(`${file}: has a loader that calls the guard before anything else is awaited`, () => {
			const body = exportedFunctionBody(source, 'loader')
			expect(body, 'missing loader').not.toBeNull()
			expectGuardFirst(body!)
		})
		const action = exportedFunctionBody(source, 'action')
		if (action !== null) {
			it(`${file}: action calls the guard before anything else is awaited`, () => {
				expectGuardFirst(action)
			})
		}
		it(`${file}: has no clientLoader or clientAction that skips the guard`, () => {
			expect(source).not.toMatch(
				/export (async )?function client(Loader|Action)\b/,
			)
		})
	}

	it('the token route guards before it mints a token', () => {
		const body = exportedFunctionBody(read(TOKEN_ROUTE), 'loader')
		expect(body, 'no loader').not.toBeNull()
		expectGuardFirst(body!)
		expect(body).toMatch(/\bmintInventoryToken\(/)
	})
})
