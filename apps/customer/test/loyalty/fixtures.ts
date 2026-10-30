import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
	LOYALTY_APPROVAL_TTL_MS,
	loyaltyCustomerApprovalSchema,
	loyaltyHistoryEntrySchema,
	loyaltyProgramResponseSchema,
	loyaltyPublicProgramSchema,
	loyaltyWalletResponseSchema,
	type LoyaltyCustomerApproval,
	type LoyaltyHistoryEntry,
	type LoyaltyPublicProgram,
	type LoyaltyWallet,
} from '@repo/loyalty'
import { type z } from 'zod'
import type approvalApproved from '../../../../packages/loyalty/contract-fixtures/approval-approved.json'
import type approvalDeclined from '../../../../packages/loyalty/contract-fixtures/approval-declined.json'
import type approvalsEmpty from '../../../../packages/loyalty/contract-fixtures/approvals-empty.json'
import type approvals from '../../../../packages/loyalty/contract-fixtures/approvals.json'
import type errorApprovalClosed from '../../../../packages/loyalty/contract-fixtures/error-approval-closed.json'
import type errorApprovalExpired from '../../../../packages/loyalty/contract-fixtures/error-approval-expired.json'
import type errorApprovalNotFound from '../../../../packages/loyalty/contract-fixtures/error-approval-not-found.json'
import type errorLoyaltyDisabled from '../../../../packages/loyalty/contract-fixtures/error-loyalty-disabled.json'
import type errorMemberInactive from '../../../../packages/loyalty/contract-fixtures/error-member-inactive.json'
import type errorMemberNotFoundCode from '../../../../packages/loyalty/contract-fixtures/error-member-not-found-code.json'
import type errorMemberNotFound from '../../../../packages/loyalty/contract-fixtures/error-member-not-found.json'
import type errorOrganizationMismatch from '../../../../packages/loyalty/contract-fixtures/error-organization-mismatch.json'
import type errorProgramInactive from '../../../../packages/loyalty/contract-fixtures/error-program-inactive.json'
import type errorRateLimited from '../../../../packages/loyalty/contract-fixtures/error-rate-limited.json'
import type errorRedemptionDisabled from '../../../../packages/loyalty/contract-fixtures/error-redemption-disabled.json'
import type errorUnavailable from '../../../../packages/loyalty/contract-fixtures/error-unavailable.json'
import type historyEmpty from '../../../../packages/loyalty/contract-fixtures/history-empty.json'
import type historyLastPage from '../../../../packages/loyalty/contract-fixtures/history-last-page.json'
import type history from '../../../../packages/loyalty/contract-fixtures/history.json'
import type memberCode from '../../../../packages/loyalty/contract-fixtures/member-code.json'
import type programNone from '../../../../packages/loyalty/contract-fixtures/program-none.json'
import type program from '../../../../packages/loyalty/contract-fixtures/program.json'
import type walletAfterApproval from '../../../../packages/loyalty/contract-fixtures/wallet-after-approval.json'
import type walletMember from '../../../../packages/loyalty/contract-fixtures/wallet-member.json'
import type walletNone from '../../../../packages/loyalty/contract-fixtures/wallet-none.json'
import type walletNotMember from '../../../../packages/loyalty/contract-fixtures/wallet-not-member.json'
import type walletOpened from '../../../../packages/loyalty/contract-fixtures/wallet-opened.json'
import type walletPaused from '../../../../packages/loyalty/contract-fixtures/wallet-paused.json'
import type walletSuspended from '../../../../packages/loyalty/contract-fixtures/wallet-suspended.json'
import type walletTermsUpdated from '../../../../packages/loyalty/contract-fixtures/wallet-terms-updated.json'

// The canonical contract fixtures recorded from tenant-api
// (`npm run fixtures:loyalty -w tenant-api`), read in place. The same files
// back the tenant-api and `@repo/loyalty` contract tests, so decoding them pins the app to the
// real shapes. `@repo/loyalty` fails when a recorded file has no type here.
type Fixtures = {
	'approval-approved': typeof approvalApproved
	'approval-declined': typeof approvalDeclined
	approvals: typeof approvals
	'approvals-empty': typeof approvalsEmpty
	'error-approval-closed': typeof errorApprovalClosed
	'error-approval-expired': typeof errorApprovalExpired
	'error-approval-not-found': typeof errorApprovalNotFound
	'error-loyalty-disabled': typeof errorLoyaltyDisabled
	'error-member-inactive': typeof errorMemberInactive
	'error-member-not-found': typeof errorMemberNotFound
	'error-member-not-found-code': typeof errorMemberNotFoundCode
	'error-organization-mismatch': typeof errorOrganizationMismatch
	'error-program-inactive': typeof errorProgramInactive
	'error-rate-limited': typeof errorRateLimited
	'error-redemption-disabled': typeof errorRedemptionDisabled
	'error-unavailable': typeof errorUnavailable
	history: typeof history
	'history-empty': typeof historyEmpty
	'history-last-page': typeof historyLastPage
	'member-code': typeof memberCode
	program: typeof program
	'program-none': typeof programNone
	'wallet-after-approval': typeof walletAfterApproval
	'wallet-member': typeof walletMember
	'wallet-none': typeof walletNone
	'wallet-not-member': typeof walletNotMember
	'wallet-opened': typeof walletOpened
	'wallet-paused': typeof walletPaused
	'wallet-suspended': typeof walletSuspended
	'wallet-terms-updated': typeof walletTermsUpdated
}

const PACKAGE_DIR = path.resolve(__dirname, '../../../../packages/loyalty')

function readFixtures(dir: string): Record<string, unknown> {
	return Object.fromEntries(
		readdirSync(dir)
			.filter((file) => file.endsWith('.json'))
			.sort()
			.map((file) => [
				file.slice(0, -'.json'.length),
				JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as unknown,
			]),
	)
}

// Every file in the folder is loaded, so a newly recorded fixture is never
// skipped; the type imports above only describe the shapes.
const FIXTURES = readFixtures(
	path.join(PACKAGE_DIR, 'contract-fixtures'),
) as Fixtures

/**
 * Hand-written answers with values a newer region may send (unknown kinds,
 * statuses and labels), kept outside the recorded folder.
 */
const FUTURE_FIXTURES = readFixtures(path.join(PACKAGE_DIR, 'future-fixtures'))

export type FixtureName = keyof typeof FIXTURES

export const FIXTURE_NAMES = Object.keys(FIXTURES) as FixtureName[]

export const FUTURE_FIXTURE_NAMES = Object.keys(FUTURE_FIXTURES)

/** A future-values fixture as a response body. */
export function futureFixtureText(name: string): string {
	if (!(name in FUTURE_FIXTURES)) throw new Error(`No future fixture ${name}`)
	return JSON.stringify(FUTURE_FIXTURES[name])
}

/** A deep copy, so a test can change it without touching other tests. */
export function fixtureJson<Name extends FixtureName>(
	name: Name,
): (typeof FIXTURES)[Name] {
	return JSON.parse(JSON.stringify(FIXTURES[name])) as (typeof FIXTURES)[Name]
}

/** The fixture as a response body. */
export function fixtureText(name: FixtureName): string {
	return JSON.stringify(FIXTURES[name])
}

/** Parses a fixture (or a changed copy) with a response schema; throws on drift. */
export function decodeFixture<Schema extends z.ZodTypeAny>(
	schema: Schema,
	value: FixtureName | object,
): z.output<Schema> {
	return schema.parse(
		typeof value === 'string' ? fixtureJson(value) : value,
	) as z.output<Schema>
}

// Builders over the recorded shapes, for the view and store tests. Each one
// parses its result with the contract schema.

export function testProgram(
	overrides: Partial<LoyaltyPublicProgram> = {},
): LoyaltyPublicProgram {
	return loyaltyPublicProgramSchema.parse({
		...fixtureJson('program').program,
		...overrides,
	})
}

type MemberOverrides = Partial<NonNullable<LoyaltyWallet['member']>>

export function testWallet(
	overrides: Partial<Omit<LoyaltyWallet, 'member'>> & {
		member?: MemberOverrides | null
	} = {},
): LoyaltyWallet {
	const { member, ...rest } = overrides
	const base = fixtureJson('wallet-member').wallet
	return loyaltyWalletResponseSchema.parse({
		wallet: {
			...base,
			...rest,
			member: member === null ? null : { ...base?.member, ...member },
		},
	}).wallet as LoyaltyWallet
}

/** The wallet of an erased account: the program, and no account or balance. */
export function testErasedWallet(
	programValue: LoyaltyPublicProgram = testProgram(),
): LoyaltyWallet {
	return testWallet({
		program: programValue,
		member: null,
		balance: null,
		nextReward: null,
	})
}

export function testApproval(
	overrides: Partial<LoyaltyCustomerApproval> = {},
): LoyaltyCustomerApproval {
	const createdAt = overrides.createdAt ?? Date.now()
	return loyaltyCustomerApprovalSchema.parse({
		...fixtureJson('approvals').approvals[0],
		createdAt,
		expiresAt: createdAt + LOYALTY_APPROVAL_TTL_MS,
		...overrides,
	})
}

export function testEntry(
	overrides: Partial<LoyaltyHistoryEntry> = {},
): LoyaltyHistoryEntry {
	return loyaltyHistoryEntrySchema.parse({
		...fixtureJson('history').entries[0],
		...overrides,
	})
}

/** The raw program payload of the `program` fixture. */
export function testProgramResponse(): {
	program: LoyaltyPublicProgram | null
} {
	return loyaltyProgramResponseSchema.parse(fixtureJson('program'))
}
