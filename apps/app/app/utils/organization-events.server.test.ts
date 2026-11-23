import {
	AuditLogRetentionPolicy,
	OrganizationEvent,
	Organization,
	db,
	eq,
	desc,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { notifyDomainEvent } from './domains/notify.server.ts'
import {
	pruneOrganizationEvents,
	recordOrganizationEvent,
} from './organization-events.server.ts'
import {
	recordBillingInvoiceEvent,
	updateOrganizationSubscription,
} from './payments.server.ts'
import { handleConnectPayoutFailed } from './shop.server.ts'

async function events(organizationId: string) {
	return db
		.select()
		.from(OrganizationEvent)
		.where(eq(OrganizationEvent.organizationId, organizationId))
		.orderBy(desc(OrganizationEvent.createdAt))
}

describe('organization event writer (#279)', () => {
	it('writes ids, states and dates, and refuses a key that could carry guest data', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

		expect(
			await recordOrganizationEvent({
				organizationId: organization.id,
				kind: 'billing_payment_failed',
				payload: { invoiceId: 'in_1', attemptCount: 1 },
			}),
		).toBe(true)

		// A guest field on an otherwise valid payload: nothing is written.
		expect(
			await recordOrganizationEvent({
				organizationId: organization.id,
				kind: 'billing_payment_failed',
				payload: { invoiceId: 'in_2', attemptCount: 1, guestName: 'Jane Doe' },
			}),
		).toBe(false)
		expect(
			await recordOrganizationEvent({
				organizationId: organization.id,
				kind: 'payout_failed',
				payload: {
					accountId: 'a',
					payoutId: 'p',
					failureCode: null,
					customerEmail: 'jane@guest.example',
				},
			}),
		).toBe(false)
		// An unknown kind is refused too.
		expect(
			await recordOrganizationEvent({
				organizationId: organization.id,
				kind: 'guest_complained' as never,
				payload: {},
			}),
		).toBe(false)

		const rows = await events(organization.id)
		expect(rows).toHaveLength(1)
		expect(JSON.stringify(rows)).not.toMatch(/Jane|guest\.example/)
		// The log names the kind only, never the payload.
		expect(JSON.stringify(error.mock.calls)).not.toMatch(/Jane|guest\.example/)
		error.mockRestore()
	})

	it('writes a retried webhook once', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		for (let attempt = 0; attempt < 3; attempt++) {
			await recordOrganizationEvent({
				organizationId: organization.id,
				kind: 'payout_failed',
				payload: {
					accountId: 'acct_1',
					payoutId: 'po_1',
					failureCode: 'account_closed',
				},
				dedupeKey: 'payout-failed:po_1',
			})
		}
		expect(await events(organization.id)).toHaveLength(1)
	})

	it('records a billing failure, and "recovered" only after one', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await db
			.update(Organization)
			.set({ stripeCustomerId: 'cus_events_1' })
			.where(eq(Organization.id, organization.id))

		// A normal paid invoice with no failure before it is not an event.
		await recordBillingInvoiceEvent({
			id: 'in_ok',
			customer: 'cus_events_1',
			outcome: 'succeeded',
		})
		expect(await events(organization.id)).toHaveLength(0)

		await recordBillingInvoiceEvent({
			id: 'in_1',
			customer: 'cus_events_1',
			attempt_count: 1,
			outcome: 'failed',
		})
		await recordBillingInvoiceEvent({
			id: 'in_1',
			customer: 'cus_events_1',
			outcome: 'succeeded',
		})
		await recordBillingInvoiceEvent({
			id: 'in_1',
			customer: 'cus_events_1',
			outcome: 'succeeded',
		})
		const kinds = (await events(organization.id)).map((row) => row.kind).sort()
		expect(kinds).toEqual([
			'billing_payment_failed',
			'billing_payment_recovered',
		])
	})

	it("records a failed payout from the Connect account, by ids and Stripe's code", async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await db
			.update(Organization)
			.set({ stripeConnectAccountId: 'acct_events_1' })
			.where(eq(Organization.id, organization.id))
		await handleConnectPayoutFailed(
			{ id: 'po_77', failure_code: 'account_closed' },
			'acct_events_1',
		)
		await handleConnectPayoutFailed({ id: 'po_78' }, 'acct_unknown')
		const rows = await events(organization.id)
		expect(rows).toHaveLength(1)
		expect(JSON.parse(rows[0]!.payload)).toEqual({
			accountId: 'acct_events_1',
			payoutId: 'po_77',
			failureCode: 'account_closed',
		})
	})

	it('records a plan change with names and states only', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await updateOrganizationSubscription(organization.id, {
			stripeSubscriptionId: 'sub_1',
			stripeProductId: 'prod_1',
			planName: 'Pro',
			subscriptionStatus: 'active',
		})
		// No change: no second event.
		await updateOrganizationSubscription(organization.id, {
			stripeSubscriptionId: 'sub_1',
			stripeProductId: 'prod_1',
			planName: 'Pro',
			subscriptionStatus: 'active',
		})
		const rows = await events(organization.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ kind: 'plan_changed' })
		expect(JSON.parse(rows[0]!.payload)).toMatchObject({
			planName: 'Pro',
			subscriptionStatus: 'active',
		})
	})

	it('records domain events through the one place that notifies about them', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await notifyDomainEvent({
			organizationId: organization.id,
			kind: 'live',
			entityId: 'dom_1',
			host: 'luigis.example',
		})
		await notifyDomainEvent({
			organizationId: organization.id,
			kind: 'renewal_failed',
			entityId: 'dom_1:2026-11',
			host: 'luigis.example',
		})
		await notifyDomainEvent({
			organizationId: organization.id,
			kind: 'pending_reminder',
			entityId: 'dom_2',
			host: 'other.example',
		})
		const rows = await events(organization.id)
		expect(rows.map((row) => row.kind).sort()).toEqual([
			'domain_failing',
			'domain_live',
			'reminder_sent',
		])
		expect(
			JSON.parse(rows.find((row) => row.kind === 'domain_failing')!.payload),
		).toEqual({
			host: 'luigis.example',
			state: 'renewal_failed',
		})
	})

	it("keeps events for the organization's audit retention period", async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		const day = 86_400_000
		const at = (days: number) => new Date(Date.now() - days * day)
		await db.insert(AuditLogRetentionPolicy).values({
			organizationId: b.organization.id,
			retentionDays: 30,
		})
		for (const [org, days] of [
			[a.organization.id, 400],
			[a.organization.id, 300],
			[b.organization.id, 40],
			[b.organization.id, 20],
		] as const) {
			await recordOrganizationEvent({
				organizationId: org,
				kind: 'reminder_sent',
				payload: { reminderKind: `r${days}` },
				dedupeKey: `k${days}`,
				at: at(days),
			})
		}
		expect(await pruneOrganizationEvents()).toBe(2)
		expect(
			(await events(a.organization.id)).map(
				(row) =>
					(JSON.parse(row.payload) as { reminderKind: string }).reminderKind,
			),
		).toEqual(['r300'])
		expect(
			(await events(b.organization.id)).map(
				(row) =>
					(JSON.parse(row.payload) as { reminderKind: string }).reminderKind,
			),
		).toEqual(['r20'])
	})
})
