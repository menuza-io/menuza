import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Print shop security sweep: every loader and action of a Marketing print
 * route (`marketing+/print*.tsx`) calls `requirePrintShopAccess` before it
 * awaits anything else, so the flag (404), the campaign permission (403) and
 * sign-in (401) answer before any design, table code or file is touched.
 * Writes must ask for `write: true`; paid orders for `pay: true`.
 */

const MARKETING_ROUTES = path.resolve(
	import.meta.dirname,
	'../../routes/_app+/$orgSlug_+/marketing+',
)

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

const files = fs
	.readdirSync(MARKETING_ROUTES)
	.filter(
		(file) => /^print[.\w$-]*\.tsx?$/.test(file) && !file.includes('.test.'),
	)
	.sort()

describe('print shop guards', () => {
	it('finds the print routes', () => {
		expect(files).toEqual(
			expect.arrayContaining([
				'print._index.tsx',
				'print.new.tsx',
				'print.$designId.tsx',
				'print.$designId.proof.tsx',
				'print.$designId.download.tsx',
				'print.canva.tsx',
				'print.canva.connect.ts',
			]),
		)
	})

	it.each(files)('%s guards every loader and action first', (file) => {
		const source = fs.readFileSync(path.join(MARKETING_ROUTES, file), 'utf8')
		for (const name of ['loader', 'action'] as const) {
			const body = exportedFunctionBody(source, name)
			if (body === null) continue
			const firstAwait = body.match(/await\s+([A-Za-z_$][\w$.]*)\s*\(/)
			expect(firstAwait?.[1], `${file} ${name}`).toBe('requirePrintShopAccess')
			if (name === 'action') {
				const call = body.slice(body.indexOf('requirePrintShopAccess('))
				expect(call.slice(0, 200), `${file} action needs write`).toMatch(
					/write:\s*true|pay:\s*true/,
				)
			}
		}
	})

	it('the Canva callback checks the hand-off, then access, then calls Canva', () => {
		const source = fs.readFileSync(
			path.resolve(
				import.meta.dirname,
				'../../routes/resources+/print.canva.callback.ts',
			),
			'utf8',
		)
		const body = exportedFunctionBody(source, 'loader') ?? ''
		const at = (needle: string) => {
			const index = body.indexOf(needle)
			if (index === -1) throw new Error(`The callback has no ${needle}`)
			return index
		}
		const state = at('sameState(')
		const access = at('requirePrintShopAccess(')
		expect(body.slice(access, access + 120)).toMatch(/write:\s*true/)
		expect(at('saved.userId !== userId')).toBeLessThan(state)
		expect(state).toBeLessThan(access)
		expect(access).toBeLessThan(at('access.features.canva'))
		expect(at('access.features.canva')).toBeLessThan(at('exchangeCanvaCode('))
	})
})
