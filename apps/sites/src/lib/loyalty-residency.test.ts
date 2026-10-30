import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Loyalty data travels only between the visitor's browser and the regional
 * tenant-api (docs/tenant-data-residency.md). This walks the server side of
 * Sites (page and component frontmatter and templates, endpoints, middleware,
 * and every local module they import) and fails if it reaches the browser
 * loyalty modules or names a loyalty route of the region.
 */

const SRC = resolve(import.meta.dirname, '..')
const SKIP = new Set(['node_modules', 'locales'])
const BROWSER_ONLY = [
	'lib/loyalty-client.ts',
	'lib/loyalty/wallet-page.ts',
	'lib/loyalty/wallet-view.ts',
	'lib/loyalty/format.ts',
	'lib/loyalty/availability.ts',
	'lib/loyalty/reward-picker.ts',
	'lib/loyalty/reward-quotes.ts',
	'lib/loyalty/tab-rewards.ts',
].map((file) => join(SRC, file))
const LOYALTY_ROUTE = /['"`}]\/(?:pos\/|operator\/)?loyalty\//
/** `'/loy' + 'alty/'` and `` `/loy` + "alty/" `` are one string once joined. */
const FRAGMENT_JOIN = /['"`]\s*\+\s*['"`]/g
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name)) continue
		const path = join(dir, name)
		if (statSync(path).isDirectory()) yield* walk(path)
		else yield path
	}
}

/** The part of a file that runs on the server: `<script>` blocks run in the browser. */
function serverSource(file: string): string {
	const source = readFileSync(file, 'utf8')
	return file.endsWith('.astro')
		? source.replace(/<script\b[\s\S]*?<\/script>/g, '')
		: source
}

/** True when `source` names a loyalty route, even split across quoted fragments. */
export function namesLoyaltyRoute(source: string): boolean {
	return LOYALTY_ROUTE.test(source.replace(FRAGMENT_JOIN, ''))
}

function resolveImport(from: string, specifier: string): string | null {
	let base: string
	if (specifier.startsWith('~/')) base = join(SRC, specifier.slice(2))
	else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier)
	else return null
	for (const candidate of [
		base,
		`${base}.ts`,
		`${base}.astro`,
		join(base, 'index.ts'),
	]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
	}
	return null
}

function isServerEntry(file: string): boolean {
	if (file.endsWith('.test.ts')) return false
	return (
		file.endsWith('.astro') ||
		file.endsWith('.server.ts') ||
		file === join(SRC, 'middleware.ts') ||
		(file.startsWith(join(SRC, 'pages')) && file.endsWith('.ts'))
	)
}

function serverGraph(): Set<string> {
	const seen = new Set<string>()
	const queue = [...walk(SRC)].filter(isServerEntry)
	while (queue.length > 0) {
		const file = queue.pop()!
		if (seen.has(file)) continue
		seen.add(file)
		for (const match of serverSource(file).matchAll(IMPORT)) {
			const target = resolveImport(file, match[1]!)
			if (target && !seen.has(target)) queue.push(target)
		}
	}
	return seen
}

describe('loyalty stays between the browser and the region', () => {
	const graph = serverGraph()
	const rel = (file: string) => relative(SRC, file)

	it('walks the server code it should', () => {
		const expected = [
			'middleware.ts',
			'pages/profile/rewards.astro',
			'pages/menu/checkout.astro',
			'components/AccountShell.astro',
			'components/ordering/TableTab.astro',
			'components/loyalty/LoyaltyLabels.astro',
			'lib/loyalty/labels.ts',
		]
		expect(expected.filter((file) => !graph.has(join(SRC, file)))).toEqual([])
	})

	it('never imports the browser loyalty modules on the server', () => {
		expect(BROWSER_ONLY.filter((file) => graph.has(file)).map(rel)).toEqual([])
	})

	it('never names a loyalty route in server code', () => {
		const hits = [...graph]
			.filter((file) => namesLoyaltyRoute(serverSource(file)))
			.map(rel)
		expect(hits).toEqual([])
	})

	it('would notice a loyalty route', () => {
		for (const file of BROWSER_ONLY.slice(0, 1)) {
			expect(LOYALTY_ROUTE.test(readFileSync(file, 'utf8'))).toBe(true)
		}
		expect(LOYALTY_ROUTE.test('fetch(`${base}/loyalty/wallet`)')).toBe(true)
		expect(LOYALTY_ROUTE.test("import x from '~/lib/loyalty/labels'")).toBe(
			false,
		)
		// A route split over concatenated fragments is still one route.
		expect(namesLoyaltyRoute("fetch(base + '/loy' + 'alty/wallet')")).toBe(true)
		expect(namesLoyaltyRoute('fetch(base + "/loyalty" + "/wallet")')).toBe(true)
		expect(namesLoyaltyRoute("get('/operator/' + 'loyalty/' + id)")).toBe(true)
		expect(namesLoyaltyRoute("import x from '~/lib/loyalty/labels'")).toBe(
			false,
		)
	})

	it('builds the wallet in a browser script', () => {
		const page = readFileSync(join(SRC, 'pages/profile/rewards.astro'), 'utf8')
		expect(page).toMatch(
			/<script>\s*import '\.\.\/\.\.\/scripts\/profile-rewards\.ts'/,
		)
		expect(
			readFileSync(join(SRC, 'scripts/profile-rewards.ts'), 'utf8'),
		).toContain('createLoyaltyClient')
	})

	it('prices rewards for checkout and the tab in the browser', () => {
		const checkout = readFileSync(
			join(SRC, 'pages/menu/checkout.astro'),
			'utf8',
		)
		expect(checkout).toMatch(
			/<script>[\s\S]*from '~\/lib\/loyalty\/reward-quotes'[\s\S]*<\/script>/,
		)
		expect(
			readFileSync(join(SRC, 'scripts/table-ordering.ts'), 'utf8'),
		).toContain("import('~/lib/loyalty/tab-rewards')")
	})
})
