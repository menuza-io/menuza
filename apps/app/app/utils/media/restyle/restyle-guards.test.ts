import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Menu restyle security sweep (#146): every loader and action of a restyle
 * route (`media_.restyle*.tsx`) awaits `requireMediaRestyleAccess` before it
 * awaits anything else, so sign-in (401), membership and the flag (404) and
 * the permission (403) answer before any run, draft or dish is touched. An
 * intent that spends model credits or changes a dish asks again for the wider
 * permission (`start`, `apply`) before it does any work; the job route
 * authenticates the internal token first.
 */

const ORG_ROUTES = path.resolve(
	import.meta.dirname,
	'../../../routes/_app+/$orgSlug_+',
)
const RESOURCE_ROUTES = path.resolve(
	import.meta.dirname,
	'../../../routes/resources+',
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
	.readdirSync(ORG_ROUTES)
	.filter(
		(file) =>
			/^media_\.restyle[.\w$-]*\.tsx?$/.test(file) && !file.includes('.test.'),
	)
	.sort()

describe('menu restyle guards', () => {
	it('finds the restyle routes', () => {
		expect(files).toEqual(['media_.restyle.$runId.tsx', 'media_.restyle.tsx'])
	})

	it.each(files)('%s guards every loader and action first', (file) => {
		const source = fs.readFileSync(path.join(ORG_ROUTES, file), 'utf8')
		for (const name of ['loader', 'action'] as const) {
			const body = exportedFunctionBody(source, name)
			if (body === null) continue
			const firstAwait = body.match(/await\s+([A-Za-z_$][\w$.]*)\s*\(/)
			expect(firstAwait?.[1], `${file} ${name}`).toBe(
				'requireMediaRestyleAccess',
			)
			// Nothing reads the request before the guard.
			expect(
				body.indexOf('requireMediaRestyleAccess('),
				`${file} ${name}`,
			).toBeLessThan(
				body.includes('formData()') ? body.indexOf('formData()') : Infinity,
			)
		}
	})

	it('starting, retrying, using and switching back ask for the wider permission', () => {
		const list = fs.readFileSync(
			path.join(ORG_ROUTES, 'media_.restyle.tsx'),
			'utf8',
		)
		const run = fs.readFileSync(
			path.join(ORG_ROUTES, 'media_.restyle.$runId.tsx'),
			'utf8',
		)
		const at = (body: string, needle: string) => {
			const index = body.indexOf(needle)
			if (index === -1) throw new Error(`No ${needle}`)
			return index
		}
		const listAction = exportedFunctionBody(list, 'action') ?? ''
		expect(at(listAction, "'start')")).toBeLessThan(
			at(listAction, 'startRestyleRun('),
		)
		const runAction = exportedFunctionBody(run, 'action') ?? ''
		expect(at(runAction, "'start')")).toBeLessThan(
			at(runAction, 'retryRestyleItem('),
		)
		expect(at(runAction, "'apply')")).toBeLessThan(
			at(runAction, 'applyAllRestyleDrafts('),
		)
		expect(at(runAction, "'apply')")).toBeLessThan(
			at(runAction, 'applyRestyleDraft('),
		)
		expect(at(runAction, "'apply')")).toBeLessThan(
			at(runAction, 'switchBackRestyleItem('),
		)
	})

	it('the job route checks the method, then the internal token, before any work', () => {
		const source = fs.readFileSync(
			path.join(RESOURCE_ROUTES, 'jobs.media-restyle.ts'),
			'utf8',
		)
		const body = exportedFunctionBody(source, 'action') ?? ''
		expect(body.indexOf('requireInternalCommandAuth(')).toBeGreaterThan(-1)
		expect(body.indexOf('requireInternalCommandAuth(')).toBeLessThan(
			body.indexOf('request.text()'),
		)
		expect(body.indexOf('requireInternalCommandAuth(')).toBeLessThan(
			body.indexOf('processRestyleRun('),
		)
		expect(body.indexOf('requireInternalCommandAuth(')).toBeLessThan(
			body.indexOf('sweepRestyleRuns('),
		)
	})
})
