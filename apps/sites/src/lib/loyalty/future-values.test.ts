// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
	loyaltyApprovalsResponseSchema,
	loyaltyHistoryResponseSchema,
	loyaltyWalletResponseSchema,
} from '@repo/loyalty'
import { describe, expect, it, vi } from 'vitest'
import {
	approvalDetail,
	describeEarning,
	formatDelta,
	formatPoints,
} from './format.ts'
import { testApproval, testProgram } from './test-fixtures.ts'
import { testLoyaltyLabels } from './test-labels.ts'
import { initWalletPage } from './wallet-page.ts'

// What the site does with values a newer region may send: rewards, entries
// and approvals of a new kind are dropped by the schemas, and a new unit
// label or earning rule ('unknown') is never put into words.

const labels = testLoyaltyLabels()
const FUTURE_DIR = resolve(
	import.meta.dirname,
	'../../../../../packages/loyalty/future-fixtures',
)

function future(name: string): unknown {
	return JSON.parse(readFileSync(resolve(FUTURE_DIR, `${name}.json`), 'utf8'))
}

describe('an unknown unit label or earning rule', () => {
	it('shows the bare number, never a guessed unit', () => {
		expect(formatPoints(1, 'unknown', labels, 'en')).toBe('1')
		expect(formatPoints(1200, 'unknown', labels, 'en')).toBe('1,200')
		expect(formatPoints(-30, 'unknown', labels, 'en')).toBe('-30')
		expect(formatDelta(12, 'unknown', labels, 'en')).toBe('+12')
		expect(formatDelta(-1, 'unknown', labels, 'en')).toBe('\u22121')
		expect(approvalDetail(testApproval(), 'unknown', labels, 'en')).not.toMatch(
			/points?|stars?/,
		)
	})

	it('leaves out a rule it cannot describe, keeping the minimum spend', () => {
		const known = describeEarning(
			testProgram({
				minimumSpendMinor: 500,
				earning: { method: 'visit', points: 5 },
			}),
			labels,
			'en',
		)
		const unknown = {
			...testProgram({ minimumSpendMinor: 500 }),
			earning: { method: 'unknown' as const },
			unitLabel: 'unknown' as const,
		}
		expect(describeEarning(unknown, labels, 'en')).toEqual(known.slice(1))
		expect(
			describeEarning({ ...unknown, minimumSpendMinor: 0 }, labels, 'en'),
		).toEqual([])
	})
})

describe('the wallet page with a newer region', () => {
	it('shows what it knows and hides the rest', async () => {
		const wallet = loyaltyWalletResponseSchema.parse(future('wallet')).wallet
		const history = loyaltyHistoryResponseSchema.parse(future('history'))
		const { approvals } = loyaltyApprovalsResponseSchema.parse(
			future('approvals'),
		)
		const root = document.createElement('div')
		document.body.append(root)
		const page = await initWalletPage(root, {
			client: {
				program: vi.fn(async () => wallet?.program ?? null),
				wallet: vi.fn(async () => wallet),
				history: vi.fn(async () => history),
				memberCode: vi.fn(),
				approvals: vi.fn(async () => approvals),
				decideApproval: vi.fn(),
			},
			labels,
			locale: 'en',
			signedIn: () => true,
			loginHref: '/login',
			pollMs: 5_000,
			isHidden: () => false,
			newKey: () => 'key',
			historyPageSize: 20,
		})
		for (let i = 0; i < 20; i++) await Promise.resolve()
		page.destroy()
		root.remove()

		expect(root.querySelector('[data-loyalty-available]')?.textContent).toBe(
			'332',
		)
		const text = root.textContent ?? ''
		expect(text).toContain('Five off your order')
		expect(text).not.toContain('Coffee bundle')
		expect(text).not.toContain('Buy one get one')
		expect(text).toContain('+20')
		expect(text).toContain('+300')
		expect(text).not.toContain('+50')
		// The terms are the business's own words; everything else is the site's.
		const siteText = text.replace(wallet?.program.terms ?? '', '')
		expect(siteText).not.toMatch(/\d (points?|stars?)\b/)
		expect(siteText).not.toMatch(/unknown|gems|streak|kiosk/i)
	})
})
