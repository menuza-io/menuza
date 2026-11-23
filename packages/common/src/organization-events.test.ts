import { describe, expect, it } from 'vitest'
import {
	ORGANIZATION_EVENT_DEFINITIONS,
	ORGANIZATION_EVENT_KINDS,
	organizationEventLink,
	organizationEventPayloadKeys,
	parseOrganizationEventPayload,
	readStoredEventPayload,
} from './organization-events.ts'

// Words that would mean guest data. No payload key may contain one.
const GUEST_WORDS = [
	'name',
	'phone',
	'email',
	'address',
	'item',
	'order',
	'note',
	'message',
	'customer',
	'guest',
	'contact',
	'body',
	'text',
]

describe('organization event payloads', () => {
	it('allow only ids, states and dates: no key names a guest or an order', () => {
		for (const kind of ORGANIZATION_EVENT_KINDS) {
			for (const key of organizationEventPayloadKeys(kind)) {
				const lower = key.toLowerCase()
				// `planName` and `host` are the restaurant's own plan and domain.
				if (key === 'planName' || key === 'previousPlanName') continue
				for (const word of GUEST_WORDS) {
					expect(lower, `${kind}.${key}`).not.toContain(word)
				}
			}
		}
	})

	it('pins the exact allowed keys of every kind', () => {
		const keys = Object.fromEntries(
			ORGANIZATION_EVENT_KINDS.map((kind) => [
				kind,
				organizationEventPayloadKeys(kind).sort(),
			]),
		)
		expect(keys).toMatchInlineSnapshot(`
			{
			  "billing_payment_failed": [
			    "attemptCount",
			    "invoiceId",
			  ],
			  "billing_payment_recovered": [
			    "invoiceId",
			  ],
			  "domain_failing": [
			    "host",
			    "state",
			  ],
			  "domain_live": [
			    "host",
			  ],
			  "domain_registered": [
			    "host",
			  ],
			  "integration_connected": [
			    "provider",
			  ],
			  "integration_disconnected": [
			    "provider",
			  ],
			  "launch_live": [],
			  "launch_step_completed": [
			    "stepKey",
			  ],
			  "payment_account_connected": [
			    "accountId",
			    "chargesEnabled",
			    "payoutsEnabled",
			  ],
			  "payment_account_needs_action": [
			    "accountId",
			    "chargesEnabled",
			    "payoutsEnabled",
			  ],
			  "payout_failed": [
			    "accountId",
			    "failureCode",
			    "payoutId",
			  ],
			  "plan_changed": [
			    "planName",
			    "previousPlanName",
			    "previousStatus",
			    "subscriptionStatus",
			  ],
			  "reminder_sent": [
			    "reminderKind",
			  ],
			}
		`)
	})

	it('refuse a key outside the allowlist for every kind', () => {
		for (const kind of ORGANIZATION_EVENT_KINDS) {
			expect(() =>
				parseOrganizationEventPayload(kind, {
					guestName: 'Jane Doe',
					guestPhone: '+15551234567',
				}),
			).toThrow()
		}
	})

	it('drop non-allowlisted keys when a stored row is read for display', () => {
		expect(
			readStoredEventPayload(
				'payout_failed',
				JSON.stringify({
					accountId: 'acct_1',
					payoutId: 'po_1',
					failureCode: 'account_closed',
					customerEmail: 'a@b.co',
				}),
			),
		).toEqual({
			accountId: 'acct_1',
			payoutId: 'po_1',
			failureCode: 'account_closed',
		})
	})

	it('link every event to the screen or log that explains it', () => {
		expect(
			organizationEventLink('payout_failed', { payoutId: 'po_9' }, 'org1'),
		).toMatchObject({
			href: 'https://dashboard.stripe.com/payouts/po_9',
			external: true,
		})
		expect(organizationEventLink('launch_live', {}, 'org1').href).toBe(
			'/organizations/org1#launch',
		)
		for (const kind of Object.keys(ORGANIZATION_EVENT_DEFINITIONS)) {
			const link = organizationEventLink(kind as never, {}, 'org1')
			expect(link.href.length).toBeGreaterThan(0)
		}
	})
})
