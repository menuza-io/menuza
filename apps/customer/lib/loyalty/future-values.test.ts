import {
	loyaltyCheckoutQuoteResponseSchema,
	type LoyaltyPublicProgram,
} from '@repo/loyalty'
import {
	approvalDetail,
	channelLabel,
	describeEarning,
	formatDelta,
	formatPoints,
} from './format'
import {
	FUTURE_FIXTURE_NAMES,
	futureFixtureText,
	testApproval,
	testProgram,
} from '@/test/loyalty/fixtures'
import { testI18n } from '@/test/loyalty/i18n'
import { makeLoyaltyClient } from '@/test/loyalty/session'
import { StubTransport } from '@/test/stub-transport'
import { makeConfiguration } from '@/test/support'

// What an older app does with values a newer region may send: one reward,
// entry or approval of a new kind is dropped, and a new label, rule or status
// decodes to 'unknown', which the wallet never puts into words.

const i18n = testI18n('en')

async function clientFor(...names: string[]) {
	const transport = new StubTransport(
		names.map((name) => ({ raw: futureFixtureText(name) })),
	)
	const { client } = await makeLoyaltyClient(transport.send, {
		configuration: makeConfiguration({
			slug: 'acme',
			origin: 'https://acme.epic-startup.com',
		}),
		newKey: () => 'generated-key',
	})
	return client
}

const KNOWN_REWARDS = [
	'00000000-0000-4000-8000-000000000001',
	'00000000-0000-4000-8000-000000000002',
]

describe('future values from the region', () => {
	it('covers every future-values fixture', () => {
		expect([...FUTURE_FIXTURE_NAMES].sort()).toEqual([
			'approval',
			'approvals',
			'checkout-quote',
			'history',
			'program',
			'wallet',
		])
	})

	it('keeps the wallet when one reward has a new kind or discount type', async () => {
		const client = await clientFor('wallet')
		const wallet = await client.wallet()
		expect(wallet?.member?.status).toBe('active')
		expect(wallet?.balance?.available).toBe(332)
		expect(wallet?.program.rewards.map((reward) => reward.id)).toEqual(
			KNOWN_REWARDS,
		)
		expect(wallet?.program.unitLabel).toBe('unknown')
		expect(wallet?.program.earning).toEqual({ method: 'unknown' })
	})

	it('keeps the public program the same way', async () => {
		const client = await clientFor('program')
		const program = await client.program()
		expect(program?.rewards.map((reward) => reward.id)).toEqual(KNOWN_REWARDS)
		expect(program?.unitLabel).toBe('unknown')
		expect(program?.earning).toEqual({ method: 'unknown' })
	})

	it('drops a history entry of a new type and keeps the rest of the page', async () => {
		const client = await clientFor('history')
		const page = await client.history()
		expect(page.entries.map((entry) => entry.id)).toEqual([
			'00000000-0000-4000-8000-000000000005',
			'00000000-0000-4000-8000-000000000006',
		])
		expect(page.nextCursor).not.toBeNull()
		const adjust = page.entries[1]
		expect(adjust?.channel).toBe('unknown')
		expect(adjust?.reason).toBe('unknown')
		expect(channelLabel(adjust?.channel ?? null, i18n)).toBeNull()
	})

	it('drops an approval of a new status and keeps the pending one', async () => {
		const client = await clientFor('approvals')
		const approvals = await client.approvals()
		expect(approvals.map((approval) => [approval.id, approval.status])).toEqual(
			[['00000000-0000-4000-8000-000000000008', 'pending']],
		)
	})

	it('accepts a decision answer with a new status', async () => {
		const client = await clientFor('approval')
		const approval = await client.decideApproval(
			'00000000-0000-4000-8000-000000000008',
			'approve',
		)
		expect(approval.status).toBe('unknown')
		expect(approval.rewardName).toBe('Five off your order')
	})

	it('decodes a till quote with a new unit label', () => {
		const quote = loyaltyCheckoutQuoteResponseSchema.parse(
			JSON.parse(futureFixtureText('checkout-quote')),
		)
		expect(JSON.stringify(quote)).toContain('"unitLabel":"unknown"')
	})
})

describe('displaying an unknown unit label or earning rule', () => {
	it('shows the bare number, never a guessed unit', () => {
		expect(formatPoints(1, 'unknown', i18n)).toBe('1')
		expect(formatPoints(1200, 'unknown', i18n)).toBe('1,200')
		expect(formatPoints(-30, 'unknown', i18n)).toBe('-30')
		expect(formatDelta(12, 'unknown', i18n)).toBe('+12')
		expect(formatDelta(-1, 'unknown', i18n)).toBe('\u22121')
		expect(formatPoints(1200, 'unknown', testI18n('ar'))).toBe('1,200')
		expect(approvalDetail(testApproval(), 'unknown', i18n)).toBe(
			'Spends 100 for $5.00 off',
		)
	})

	it('leaves out an earning rule it cannot describe, keeping the minimum spend', () => {
		const future = {
			...testProgram({ minimumSpendMinor: 500 }),
			earning: { method: 'unknown' },
			unitLabel: 'unknown',
		} satisfies LoyaltyPublicProgram
		const known = describeEarning(
			testProgram({
				minimumSpendMinor: 500,
				earning: { method: 'visit', points: 5 },
			}),
			i18n,
		)
		expect(describeEarning(future, i18n)).toEqual(known.slice(1))
		expect(describeEarning({ ...future, minimumSpendMinor: 0 }, i18n)).toEqual(
			[],
		)
	})
})
