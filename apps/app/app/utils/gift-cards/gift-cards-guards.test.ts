import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every gift card loader and action awaits `requireGiftCardAccess` before any
 * other await, so a flag that is off or a missing grant answers before any
 * work happens (and before a form body is read). The token route is included:
 * it mints the browser-direct credential. Routes that only render (the list
 * reads straight from the region with that token) have no loader, and the
 * layout loader guards them. Actions that change anything ask for the update
 * grant.
 */

const APP_DIR = path.resolve(import.meta.dirname, '../..')
const ROUTES_DIR = path.join(APP_DIR, 'routes/_app+/$orgSlug_+/gift-cards+')
const TOKEN_ROUTE = path.join(
	APP_DIR,
	'routes/_app+/$orgSlug_+/gift-cards-token.ts',
)

const GUARD_CALL = /\brequireGiftCardAccess\(/

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

function assertGuardFirst(body: string) {
	const guard = body.search(GUARD_CALL)
	expect(guard, 'no guard call').toBeGreaterThanOrEqual(0)
	const firstAwait = body.indexOf('await ')
	expect(firstAwait).toBeGreaterThanOrEqual(0)
	expect(body.slice(firstAwait, firstAwait + 80)).toMatch(GUARD_CALL)
	const beforeGuard = body.slice(0, guard)
	expect(beforeGuard).not.toMatch(/request\.(formData|json|text)\(/)
	expect(beforeGuard).not.toMatch(/\bdb\b/)
}

describe('gift card guards', () => {
	const files = fs.readdirSync(ROUTES_DIR).filter((file) => file.endsWith('.tsx'))

	it('finds the gift card routes', () => {
		expect(files).toEqual(
			expect.arrayContaining(['_layout.tsx', '_index.tsx', '$cardId.tsx', 'settings.tsx']),
		)
	})

	for (const file of files) {
		const source = read(path.join(ROUTES_DIR, file))
		for (const name of ['loader', 'action']) {
			const body = exportedFunctionBody(source, name)
			if (body === null) continue
			it(`${file}: ${name} calls the guard before anything else is awaited`, () => {
				assertGuardFirst(body)
			})
		}
		it(`${file}: an action that changes something needs the update grant`, () => {
			const body = exportedFunctionBody(source, 'action')
			if (body === null) return
			expect(body).toMatch(/UPDATE_GIFT_CARD/)
		})
	}

	it('the layout has a loader, so every screen under it is guarded', () => {
		expect(exportedFunctionBody(read(path.join(ROUTES_DIR, '_layout.tsx')), 'loader')).not.toBeNull()
	})

	it('the token route guards before it mints a token, and never for an unknown scope', () => {
		const body = exportedFunctionBody(read(TOKEN_ROUTE), 'loader')
		expect(body, 'no loader').not.toBeNull()
		const guard = body!.search(GUARD_CALL)
		expect(guard, 'no guard call').toBeGreaterThanOrEqual(0)
		expect(body).toMatch(/\bmintGiftCardToken\(/)
		expect(body).toMatch(/impersonated:\s*access\.impersonated/)
		// The guard sits before the mint.
		expect(guard).toBeLessThan(body!.indexOf('mintGiftCardToken('))
	})

	it('the settings screen is for managers only', () => {
		const source = read(path.join(ROUTES_DIR, 'settings.tsx'))
		for (const name of ['loader', 'action']) {
			expect(exportedFunctionBody(source, name)).toMatch(/requireAll:\s*\[GIFT_CARD_PERMISSIONS\.UPDATE_GIFT_CARD\]/)
		}
		expect(exportedFunctionBody(source, 'action')).toMatch(/access\.impersonated/)
	})
})
