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
import { type LoyaltyTx } from '../lib/loyalty-write.ts'
import {
	approvalsForSaleInTx,
	purgeLoyaltyAccessInTx,
} from './loyalty-code-service.ts'
import { latestRedemptionForSourceInTx } from './loyalty-purchase-service.ts'
import { NOW } from './loyalty-test-fixture.ts'

/**
 * The lookups the reconciler, the till and the tick run on every sale or
 * every few minutes must use an index, not scan a table that only grows.
 */

const ORG = 'org_ll_plans'

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-plans-'))
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

/** Runs `fn` against the org's database and returns the plan of every statement. */
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

describe('loyalty query plans', () => {
	it('finds a source’s latest redemption through the source index', async () => {
		const plans = await plansOf((db) =>
			latestRedemptionForSourceInTx(db, {
				type: 'restaurant_order',
				id: 'ord_1',
			}),
		)
		expect(plans).toHaveLength(2)
		for (const { plan } of plans) {
			expect(plan).toMatch(
				/SEARCH loyalty_redemptions USING INDEX (idx_loyalty_redemptions_source|loyalty_redemptions_one_per_source) \(source_type=\? AND source_id=\?\)/,
			)
		}
		// The fallback reads released rows too, which the partial index omits.
		expect(plans[1]!.plan).toContain('idx_loyalty_redemptions_source')
	})

	it('finds a till sale’s earlier requests through the sale index', async () => {
		const [statement, ...rest] = await plansOf((db) =>
			approvalsForSaleInTx(db, 'sale_1'),
		)
		expect(rest).toEqual([])
		expect(statement!.plan).toMatch(
			/SEARCH loyalty_approvals USING INDEX idx_loyalty_approvals_sale \(sale_id=\?\)/,
		)
	})

	it('purges closed requests through the status and age index', async () => {
		const plans = await plansOf((db) =>
			purgeLoyaltyAccessInTx(db as unknown as LoyaltyTx, NOW),
		)
		const approvals = plans.find(({ query }) =>
			query.startsWith('delete from "loyalty_approvals"'),
		)
		expect(approvals?.plan).toMatch(
			/SEARCH loyalty_approvals USING (COVERING )?INDEX idx_loyalty_approvals_status_updated \(status=\? AND updated_at<\?\)/,
		)
	})
})
