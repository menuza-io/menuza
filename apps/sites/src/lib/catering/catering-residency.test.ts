import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A catering guest's name, phone, email, notes and quote are regional data:
 * the browser talks to tenant-api directly and Sites' server never sees them
 * (docs/tenant-data-residency.md). The quote and balance links are capabilities
 * that stay in the URL fragment. This keeps the server-side parts of Sites away
 * from the browser-only catering client and the regional catering routes.
 */
const SRC = path.resolve(import.meta.dirname, '../..')
const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8')
const frontmatter = (file: string) =>
	/^---\n([\s\S]*?)\n---/.exec(read(file))?.[1] ?? ''

describe('catering stays out of Sites’ server', () => {
	for (const page of [
		'pages/catering/index.astro',
		'pages/catering/quote.astro',
		'pages/catering/balance.astro',
	]) {
		it(`${page}: the frontmatter imports no browser client and calls no region`, () => {
			const server = frontmatter(page)
			expect(server).not.toMatch(/lib\/catering\/client/)
			expect(server).not.toMatch(/Authorization|fetch\(/)
			expect(server).not.toMatch(/tenantApiUrl[^\n]*\/catering/i)
		})
	}

	it('the quote and balance pages read their link from the fragment, never the query', () => {
		const client = read('lib/catering/client.ts')
		expect(client).toContain('location.hash')
		expect(client).not.toMatch(/searchParams\.get\('(q|b|token)'\)/)
		for (const page of [
			'pages/catering/quote.astro',
			'pages/catering/balance.astro',
		]) {
			expect(frontmatter(page)).not.toMatch(/searchParams|location\.hash/)
		}
	})

	it('has no Sites API route that proxies quotes or balances', () => {
		const files = fs.readdirSync(path.join(SRC, 'pages/api'), {
			recursive: true,
		}) as string[]
		expect(files.filter((f) => /catering/i.test(f))).toEqual([])
	})
})
