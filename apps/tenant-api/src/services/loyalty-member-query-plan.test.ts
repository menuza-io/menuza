import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listLoyaltyActivity } from './loyalty-activity-service.ts'
import {
	encodeLoyaltyCursor,
	memberForCustomerInTx,
} from './loyalty-member-service.ts'
import { NOW } from './loyalty-test-fixture.ts'

/**
 * The lookups the points accounts depend on must use their indexes: the
 * customer's account (sign-in, wallet, every order) and the activity feed.
 */

const ORG = 'org_ll_member_plans'

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-member-plans-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => {})
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

type Statement = { query: string; params: unknown[] }

async function plansOf(fn: (db: TenantDatabase) => Promise<unknown>) {
	const { $client: client } = (await getTenantDb(ORG)) as unknown as {
		$client: Parameters<typeof drizzle>[0]
	}
	const statements: Statement[] = []
	const recording = drizzle(client as never, {
		logger: {
			logQuery: (query, params) => statements.push({ query, params }),
		},
	})
	await fn(recording as unknown as TenantDatabase)
	const plans: Array<{ query: string; plan: string }> = []
	for (const statement of statements) {
		const result = await (
			client as unknown as {
				execute: (input: {
					sql: string
					args: unknown[]
				}) => Promise<{ rows: Array<Record<string, unknown>> }>
			}
		).execute({
			sql: `EXPLAIN QUERY PLAN ${statement.query}`,
			args: statement.params,
		})
		plans.push({
			query: statement.query,
			plan: result.rows.map((row) => String(row.detail)).join('\n'),
		})
	}
	return plans
}

describe('loyalty account query plans', () => {
	it('finds a customer’s account through the unique customer index', async () => {
		const plans = await plansOf((db) =>
			memberForCustomerInTx(db, 'customer_lookup'),
		)
		const lookup = plans.find(({ query }) =>
			/^select .* from "loyalty_members"/.test(query),
		)
		expect(lookup?.plan).toMatch(
			/SEARCH loyalty_members USING INDEX loyalty_members_customer_unique \(customer_id=\?\)/,
		)
	})

	it('walks the activity feed in time order and joins accounts by key', async () => {
		const plans = await plansOf((db) =>
			listLoyaltyActivity(db, {
				locationIds: null,
				cursor: encodeLoyaltyCursor(NOW, 'ledger_cursor'),
			}),
		)
		const feed = plans.find(({ query }) =>
			/^select .* from "loyalty_ledger"/.test(query),
		)
		expect(feed?.plan).toMatch(/USING INDEX idx_loyalty_ledger_at/)
		expect(feed?.plan).not.toMatch(/SCAN loyalty_members/)
		expect(feed?.plan).toMatch(
			/SEARCH loyalty_members USING (INTEGER )?PRIMARY KEY|SEARCH loyalty_members USING INDEX sqlite_autoindex_loyalty_members_1/,
		)
	})
})
