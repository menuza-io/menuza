import { db, eq, PaymentPayoutCache } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	process.env.PAYMENTS_MOCK = 'true'
	process.env.BASE_URL = 'https://app.menuza.test:2999'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader as detailLoader } from './$payoutId.tsx'
import { loader as indexLoader } from './_index.tsx'

describe('Payments payouts routes & permission guards (#168)', () => {
	it('returns 403 for members without read:payments:any (guard test first)', async () => {
		const { organization } = await setupTestOrgWithUser()
		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(member.id)

		const reqIndex = createAuthenticatedRequest(
			`https://app.menuza.test:2999/${organization.slug}/payments`,
			{},
			cookie,
		)
		await expect(
			indexLoader({
				request: reqIndex,
				params: { orgSlug: organization.slug },
				context: {},
			} as never),
		).rejects.toSatisfy(
			(res: unknown) => res instanceof Response && res.status === 403,
		)

		const reqDetail = createAuthenticatedRequest(
			`https://app.menuza.test:2999/${organization.slug}/payments/po_mock_connect_1`,
			{},
			cookie,
		)
		await expect(
			detailLoader({
				request: reqDetail,
				params: { orgSlug: organization.slug, payoutId: 'po_mock_connect_1' },
				context: {},
			} as never),
		).rejects.toSatisfy(
			(res: unknown) => res instanceof Response && res.status === 403,
		)
	})

	it('returns 4-part balance split, payouts list, cached reads, refresh, and CSV export for admin', async () => {
		const { organization, cookie } = await setupTestOrgWithUser()

		const first = await indexLoader({
			request: createAuthenticatedRequest(
				`https://app.menuza.test:2999/${organization.slug}/payments`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)

		expect(first.cached).toBe(false)
		expect(first.snapshot.balance).toMatchObject({
			availableCents: expect.any(Number),
			inTransitCents: expect.any(Number),
			pendingCents: expect.any(Number),
			reservedCents: expect.any(Number),
		})
		expect(first.snapshot.payouts.length).toBeGreaterThanOrEqual(1)

		// Second read hits 10-minute cache
		const second = await indexLoader({
			request: createAuthenticatedRequest(
				`https://app.menuza.test:2999/${organization.slug}/payments`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		expect(second.cached).toBe(true)

		// Refresh bypasses cache
		const refreshed = await indexLoader({
			request: createAuthenticatedRequest(
				`https://app.menuza.test:2999/${organization.slug}/payments?refresh=1`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		expect(refreshed.cached).toBe(false)

		// Detail includes payments, refund, dispute, and unmatched transaction
		const detail = (await detailLoader({
			request: createAuthenticatedRequest(
				`https://app.menuza.test:2999/${organization.slug}/payments/po_mock_connect_1`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug, payoutId: 'po_mock_connect_1' },
			context: {},
		} as never)) as {
			detail: { transactions: Array<{ kind: string; orderId: string | null }> }
		}

		const kinds = detail.detail.transactions.map((t) => t.kind)
		expect(kinds).toContain('payment')
		expect(kinds).toContain('refund')
		expect(kinds).toContain('dispute')
		expect(detail.detail.transactions.some((t) => t.orderId === null)).toBe(
			true,
		)

		// CSV export uses @repo/reports/export
		const csvRes = (await detailLoader({
			request: createAuthenticatedRequest(
				`https://app.menuza.test:2999/${organization.slug}/payments/po_mock_connect_1?format=csv`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug, payoutId: 'po_mock_connect_1' },
			context: {},
		} as never)) as Response
		expect(csvRes).toBeInstanceOf(Response)
		expect(csvRes.headers.get('Content-Type')).toContain('text/csv')
		const csvText = await csvRes.text()
		expect(csvText).toContain('Transaction ID,Type,Order Ref')
		expect(csvText).toContain('txn_mock_refund_1')
		expect(csvText).toContain('txn_mock_dispute_1')

		await db
			.delete(PaymentPayoutCache)
			.where(eq(PaymentPayoutCache.organizationId, organization.id))
	})
})
