import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Gift card codes, balances and the buyer's and recipient's details are
 * regional data: the browser talks to tenant-api directly and Sites' server
 * never sees them (docs/tenant-data-residency.md). This keeps the server-side
 * parts of Sites (page frontmatter, endpoints, middleware) away from the
 * browser-only gift card client and from the regional gift card routes.
 */

const SRC = path.resolve(import.meta.dirname, '../..')

function read(file: string) {
	return fs.readFileSync(path.join(SRC, file), 'utf8')
}

function frontmatter(file: string): string {
	const text = read(file)
	const match = /^---\n([\s\S]*?)\n---/.exec(text)
	return match?.[1] ?? ''
}

const PAGES = [
	'pages/gift-cards/index.astro',
	'pages/gift-cards/balance.astro',
	'pages/profile/gift-cards.astro',
]

describe('gift cards stay out of Sites’ server', () => {
	for (const page of PAGES) {
		it(`${page}: the frontmatter imports no browser client and names no regional route`, () => {
			const server = frontmatter(page)
			expect(server).not.toMatch(/lib\/gift-cards\/client/)
			// The page's own links are fine; a call to the region is not.
			expect(server).not.toMatch(/tenantApiUrl[^\n]*gift-cards/i)
			expect(server).not.toMatch(/\$\{[^}]*tenant[^}]*\}\/gift-cards/i)
			expect(server).not.toMatch(/Authorization|fetch\(/)
		})
	}

	it('no endpoint or middleware proxies gift card calls', () => {
		const apiDir = path.join(SRC, 'pages/api')
		const files = fs.readdirSync(apiDir, { recursive: true }).map(String)
		for (const file of files.filter((name) => name.endsWith('.ts'))) {
			const text = fs.readFileSync(path.join(apiDir, file), 'utf8')
			expect(text, file).not.toMatch(/\/gift-cards\/(purchase|balance|claim|mine)/)
		}
	})

	it('the payment hand-off carries the opaque reference only', () => {
		const client = read('lib/gift-cards/client.ts')
		const handoff = client.slice(client.indexOf('export async function startPayment'))
		const body = handoff.slice(0, handoff.indexOf('const value'))
		expect(body).toContain('orderId: orderRef')
		expect(body).toContain('paymentToken')
		expect(body).not.toMatch(/email|name|message|recipient/i)
	})
})
