import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isLoyaltyErrorCode } from './errors.ts'
import {
	loyaltyApprovalResponseSchema,
	loyaltyApprovalsResponseSchema,
	loyaltyCheckoutQuoteResponseSchema,
	loyaltyErrorResponseSchema,
	loyaltyHistoryResponseSchema,
	loyaltyMemberCodeResponseSchema,
	loyaltyProgramResponseSchema,
	loyaltyWalletResponseSchema,
} from './schemas/index.ts'

/**
 * The canonical customer-API fixtures are recorded by
 * `npm run fixtures:loyalty -w tenant-api`. This package-level test needs no
 * database: it parses every fixture with the shared response schemas, so the
 * clients that test against these files test against the real contract.
 */

const ROOT = path.resolve(import.meta.dirname, '../../..')
const CANONICAL = path.join(ROOT, 'packages/loyalty/contract-fixtures')
/**
 * Hand-written answers carrying values a newer region may send. Kept outside
 * the recorded folder, which the recorder deletes and rewrites.
 */
const FUTURE = path.join(ROOT, 'packages/loyalty/future-fixtures')
const CUSTOMER_APP_FIXTURES = path.join(
	ROOT,
	'apps/customer/test/loyalty/fixtures.ts',
)

const SUCCESS_SCHEMAS: Record<
	string,
	{ safeParse(value: unknown): { success: boolean } }
> = {
	program: loyaltyProgramResponseSchema,
	'program-none': loyaltyProgramResponseSchema,
	'wallet-not-member': loyaltyWalletResponseSchema,
	'wallet-member': loyaltyWalletResponseSchema,
	'wallet-after-approval': loyaltyWalletResponseSchema,
	'wallet-paused': loyaltyWalletResponseSchema,
	'wallet-suspended': loyaltyWalletResponseSchema,
	'wallet-none': loyaltyWalletResponseSchema,
	'wallet-opened': loyaltyWalletResponseSchema,
	'wallet-terms-updated': loyaltyWalletResponseSchema,
	history: loyaltyHistoryResponseSchema,
	'history-empty': loyaltyHistoryResponseSchema,
	'history-last-page': loyaltyHistoryResponseSchema,
	'member-code': loyaltyMemberCodeResponseSchema,
	approvals: loyaltyApprovalsResponseSchema,
	'approvals-empty': loyaltyApprovalsResponseSchema,
	'approval-approved': loyaltyApprovalResponseSchema,
	'approval-declined': loyaltyApprovalResponseSchema,
}

/** Codes the routes add outside the domain list. */
const ROUTE_CODES = new Set(['organization_mismatch'])

const ERROR_FIXTURES = [
	'error-approval-closed',
	'error-approval-expired',
	'error-approval-not-found',
	'error-loyalty-disabled',
	'error-member-inactive',
	'error-member-not-found',
	'error-member-not-found-code',
	'error-organization-mismatch',
	'error-program-inactive',
	'error-rate-limited',
	'error-redemption-disabled',
	'error-unavailable',
]

const files = (dir: string) =>
	fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.json'))
		.sort()
const read = (name: string): unknown =>
	JSON.parse(fs.readFileSync(path.join(CANONICAL, `${name}.json`), 'utf8'))

describe('loyalty contract fixtures', () => {
	it('has a schema for every canonical fixture and a fixture for every schema', () => {
		expect(files(CANONICAL)).toEqual(
			[...Object.keys(SUCCESS_SCHEMAS), ...ERROR_FIXTURES]
				.map((name) => `${name}.json`)
				.sort(),
		)
	})

	it.each(Object.keys(SUCCESS_SCHEMAS))(
		'parses %s with the public schema',
		(name) => {
			expect(SUCCESS_SCHEMAS[name]!.safeParse(read(name)).success).toBe(true)
		},
	)

	it.each(ERROR_FIXTURES)('parses %s as an error with a known code', (name) => {
		const fixture = read(name) as { error: string; code: string }
		expect(loyaltyErrorResponseSchema.safeParse(fixture).success).toBe(true)
		expect(fixture.error).toBe(fixture.code)
		expect(
			isLoyaltyErrorCode(fixture.code) || ROUTE_CODES.has(fixture.code),
			fixture.code,
		).toBe(true)
	})

	it('carries the details the apps read from an error', () => {
		expect(read('error-rate-limited')).toMatchObject({
			retryAfterSeconds: expect.any(Number),
		})
	})

	it('holds no contact details', () => {
		for (const file of files(CANONICAL)) {
			const text = fs.readFileSync(path.join(CANONICAL, file), 'utf8')
			expect(text, file).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
			expect(text, file).not.toMatch(/\+\d{8,}/)
		}
	})

	it('is typed file by file by the customer app tests', () => {
		const source = fs.readFileSync(CUSTOMER_APP_FIXTURES, 'utf8')
		const imported = [
			...source.matchAll(
				/from '(?:\.\.\/)+packages\/loyalty\/contract-fixtures\/([^']+\.json)'/g,
			),
		]
			.map((match) => match[1])
			.sort()
		expect(imported).toEqual(files(CANONICAL))
	})
})

const FUTURE_SCHEMAS: Record<
	string,
	{ safeParse(value: unknown): { success: boolean } }
> = {
	approval: loyaltyApprovalResponseSchema,
	approvals: loyaltyApprovalsResponseSchema,
	'checkout-quote': loyaltyCheckoutQuoteResponseSchema,
	history: loyaltyHistoryResponseSchema,
	program: loyaltyProgramResponseSchema,
	wallet: loyaltyWalletResponseSchema,
}

const readFuture = (name: string): any =>
	JSON.parse(fs.readFileSync(path.join(FUTURE, `${name}.json`), 'utf8'))

describe('loyalty future values', () => {
	it('has a schema for every future fixture', () => {
		expect(files(FUTURE)).toEqual(
			Object.keys(FUTURE_SCHEMAS)
				.map((name) => `${name}.json`)
				.sort(),
		)
	})

	it('lives outside the folder the recorder rewrites', () => {
		expect(path.relative(CANONICAL, FUTURE).startsWith('..')).toBe(true)
	})

	it.each(Object.keys(FUTURE_SCHEMAS))('parses %s', (name) => {
		expect(FUTURE_SCHEMAS[name]!.safeParse(readFuture(name)).success).toBe(true)
	})

	it('drops rewards of an unknown kind or discount and marks unknown scalars', () => {
		const raw = readFuture('wallet')
		const wallet = loyaltyWalletResponseSchema.parse(raw).wallet!
		const program = wallet.program
		expect(program.unitLabel).toBe('unknown')
		expect(program.earning).toEqual({ method: 'unknown' })
		expect(program.rewards.map((reward) => reward.id)).toEqual([
			raw.wallet.program.rewards[0].id,
			raw.wallet.program.rewards[3].id,
		])
		expect(program.rewards[0]).not.toHaveProperty('stackable')
		expect(program.rewards[0]!.discount).toEqual({
			type: 'fixed',
			amountMinor: 500,
		})
		expect(program.labels).toEqual({
			items: { item_latte: 'Latte' },
			categories: { cat_pastry: 'Pastries' },
		})
		expect(wallet.member?.status).toBe('active')
		expect(wallet.balance).toEqual(raw.wallet.balance)
		expect(wallet).not.toHaveProperty('tier')

		const alone = loyaltyProgramResponseSchema.parse(readFuture('program'))
		expect(alone.program).toEqual(program)
	})

	it('drops history entries of an unknown type and keeps the rest of the page', () => {
		const raw = readFuture('history')
		const page = loyaltyHistoryResponseSchema.parse(raw)
		expect(page.entries.map((entry) => entry.id)).toEqual([
			raw.entries[0].id,
			raw.entries[2].id,
		])
		expect(page.entries[0]!.channel).toBe('web')
		expect(page.entries[1]).toMatchObject({
			type: 'adjust',
			channel: 'unknown',
			reason: 'unknown',
		})
		expect(page.nextCursor).toBe(raw.nextCursor)
	})

	it('drops approvals of an unknown status from a list, marks a single one unknown', () => {
		const raw = readFuture('approvals')
		const list = loyaltyApprovalsResponseSchema.parse(raw).approvals
		expect(list.map((approval) => [approval.id, approval.status])).toEqual([
			[raw.approvals[0].id, 'pending'],
		])
		const one = loyaltyApprovalResponseSchema.parse(readFuture('approval'))
		expect(one.approval.status).toBe('unknown')
	})

	it('marks an unknown unit label on a checkout quote', () => {
		const quote = loyaltyCheckoutQuoteResponseSchema.parse(
			readFuture('checkout-quote'),
		)
		expect(quote.unitLabel).toBe('unknown')
		expect(quote.rewards).toHaveLength(1)
	})

	it('still refuses a known value with a broken shape', () => {
		const wallet = read('wallet-member') as any
		wallet.wallet.program.rewards[0].discount = { type: 'fixed' }
		expect(loyaltyWalletResponseSchema.safeParse(wallet).success).toBe(false)

		const earning = read('wallet-member') as any
		earning.wallet.program.earning = { method: 'spend', points: 1 }
		expect(loyaltyWalletResponseSchema.safeParse(earning).success).toBe(false)

		const unit = read('wallet-member') as any
		unit.wallet.program.unitLabel = 7
		expect(loyaltyWalletResponseSchema.safeParse(unit).success).toBe(false)

		const history = read('history') as any
		history.entries[0].delta = '20'
		expect(loyaltyHistoryResponseSchema.safeParse(history).success).toBe(false)

		const approvals = read('approvals') as any
		approvals.approvals[0].pointsCost = 0
		expect(loyaltyApprovalsResponseSchema.safeParse(approvals).success).toBe(
			false,
		)
	})

	it('refuses a currency that is not an ISO code', () => {
		for (const currency of ['usd', 'US', 'USD$', '']) {
			const approvals = read('approvals') as any
			approvals.approvals[0].currency = currency
			expect(
				loyaltyApprovalsResponseSchema.safeParse(approvals).success,
				currency,
			).toBe(false)
			const wallet = read('wallet-member') as any
			wallet.wallet.program.currency = currency
			expect(
				loyaltyWalletResponseSchema.safeParse(wallet).success,
				currency,
			).toBe(false)
		}
	})
})
