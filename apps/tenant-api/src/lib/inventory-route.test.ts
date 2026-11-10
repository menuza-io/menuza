import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MONEY_FIELDS } from './inventory-route.ts'

/**
 * Every response field of the inventory contract that carries money must be in
 * `MONEY_FIELDS`, the list `respond` strips for a token without the cost grant.
 * A new `...Minor` / `...Micro` output field that is not listed would leak to
 * cost-less tokens, so this walks the contract files.
 */
const CONTRACT_DIR = path.resolve(
	__dirname,
	'../../../../packages/inventory/src/contract',
)

/** Request-only fields (the cost-less token never receives them back). */
const REQUEST_ONLY = new Set([
	'minor', // a typed cost the caller sends
])

function outputMoneyFields(): string[] {
	const found = new Set<string>()
	for (const file of fs.readdirSync(CONTRACT_DIR)) {
		if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
		const text = fs.readFileSync(path.join(CONTRACT_DIR, file), 'utf8')
		// Output fields are declared with the `minorOut` helper or, for
		// micro-minor costs, as a plain integer field named `...Micro`.
		for (const match of text.matchAll(/(\w+):\s*minorOut\b/g)) {
			found.add(match[1]!)
		}
		for (const match of text.matchAll(/\b(\w+Micro):\s*z\.number\(\)/g)) {
			found.add(match[1]!)
		}
	}
	return [...found].filter((name) => !REQUEST_ONLY.has(name)).sort()
}

describe('MONEY_FIELDS', () => {
	it('lists every money field the contract answers with', () => {
		const listed = new Set<string>(MONEY_FIELDS)
		const missing = outputMoneyFields().filter((name) => !listed.has(name))
		expect(missing).toEqual([])
	})

	it('strips the unpaid-deliveries amount', () => {
		expect(MONEY_FIELDS).toContain('amountMinor')
	})
})
