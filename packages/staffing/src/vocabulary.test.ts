import { describe, expect, it } from 'vitest'

// The generic core talks about "scopes" (the part of the business staff work
// at), never about a business type. A vertical maps its own words, such as
// "location", onto `scopeId`. "Orders" stay allowed: the labor summary reads
// online sales from checkout orders, which every business can have.
const FORBIDDEN = [
	/restaurant/i,
	/\blocations?\b/i,
	/\bstores?\b/i,
	/\bmenus?\b/i,
	/\bdish(?:es)?\b/i,
	/\bfood\b/i,
	/\bkitchen\b/i,
	/\bdine-?in\b/i,
	/\bcaterin/i,
	/\bchef\b/i,
]

function coreSources() {
	const files = import.meta.glob<string>(['./*.ts', '!./*.test.ts'], {
		query: '?raw',
		import: 'default',
		eager: true,
	})
	return Object.entries(files).map(([name, text]) => ({ name, text }))
}

describe('core vocabulary', () => {
	it('has no business-type words', () => {
		const hits: string[] = []
		for (const { name, text } of coreSources()) {
			text.split('\n').forEach((line, index) => {
				for (const pattern of FORBIDDEN) {
					const match = pattern.exec(line)
					if (match) hits.push(`${name}:${index + 1}: "${match[0]}"`)
				}
			})
		}
		expect(hits).toEqual([])
	})

	it('has no camel-cased or snake-cased location names', () => {
		const hits: string[] = []
		for (const { name, text } of coreSources()) {
			text.split('\n').forEach((line, index) => {
				if (/[a-z_]Location|\blocation[A-Z_]/.test(line)) {
					hits.push(`${name}:${index + 1}`)
				}
			})
		}
		expect(hits).toEqual([])
	})

	it('exposes one default scope', async () => {
		const { DEFAULT_SCOPE_ID } = await import('./scope.ts')
		expect(DEFAULT_SCOPE_ID).toBe('main')
	})
})
