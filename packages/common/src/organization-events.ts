import { z } from 'zod'

/**
 * Account events for the Admin Timeline (#279). Texting events (a business
 * line sent a code, verified, removed; a text allowance granted) already have
 * audit rows, so the Timeline reads those instead of writing a second row. An event is a kind, a place
 * (optional location id), a few ids and states, and a time. It NEVER holds a
 * guest's name, phone, email, address or order contents: each kind has its own
 * strict payload schema, the writer refuses anything that does not fit it, and
 * a test pins the allowed keys. Events whose facts already live in an audit row,
 * a support request or an assignment are not written here; the Timeline reads
 * those from their own tables.
 */

export const ORGANIZATION_EVENT_GROUPS = [
	'plan',
	'launch',
	'payments',
	'domain',
	'billing',
	'integrations',
	'reminders',
] as const
export type OrganizationEventGroup = (typeof ORGANIZATION_EVENT_GROUPS)[number]

const short = z.string().trim().min(1).max(80)
const id = z.string().trim().min(1).max(80)

/** Per kind: the group, the label and the one strict payload schema. */
export const ORGANIZATION_EVENT_DEFINITIONS = {
	plan_changed: {
		group: 'plan',
		label: 'Plan changed',
		payload: z.strictObject({
			planName: short.nullable(),
			previousPlanName: short.nullable().optional(),
			subscriptionStatus: short.nullable(),
			previousStatus: short.nullable().optional(),
		}),
	},
	launch_step_completed: {
		group: 'launch',
		label: 'Launch step completed',
		payload: z.strictObject({ stepKey: short }),
	},
	launch_live: {
		group: 'launch',
		label: 'Location went live',
		payload: z.strictObject({}),
	},
	payment_account_connected: {
		group: 'payments',
		label: 'Payment account connected',
		payload: z.strictObject({
			accountId: id,
			chargesEnabled: z.boolean(),
			payoutsEnabled: z.boolean(),
		}),
	},
	payment_account_needs_action: {
		group: 'payments',
		label: 'Payment account needs action',
		payload: z.strictObject({
			accountId: id,
			chargesEnabled: z.boolean(),
			payoutsEnabled: z.boolean(),
		}),
	},
	payout_failed: {
		group: 'payments',
		label: 'Payout failed',
		payload: z.strictObject({
			accountId: id,
			payoutId: id,
			failureCode: short.nullable(),
		}),
	},
	domain_live: {
		group: 'domain',
		label: 'Domain connected',
		payload: z.strictObject({ host: short }),
	},
	domain_failing: {
		group: 'domain',
		label: 'Domain failing',
		payload: z.strictObject({ host: short, state: short }),
	},
	domain_registered: {
		group: 'domain',
		label: 'Domain registered',
		payload: z.strictObject({ host: short }),
	},
	billing_payment_failed: {
		group: 'billing',
		label: 'Billing payment failed',
		payload: z.strictObject({
			invoiceId: id,
			attemptCount: z.number().int().min(0).max(100).nullable(),
		}),
	},
	billing_payment_recovered: {
		group: 'billing',
		label: 'Billing payment recovered',
		payload: z.strictObject({ invoiceId: id }),
	},
	integration_connected: {
		group: 'integrations',
		label: 'Integration connected',
		payload: z.strictObject({ provider: short }),
	},
	integration_disconnected: {
		group: 'integrations',
		label: 'Integration disconnected',
		payload: z.strictObject({ provider: short }),
	},
	reminder_sent: {
		group: 'reminders',
		label: 'Reminder sent',
		payload: z.strictObject({ reminderKind: short }),
	},
} as const

export type OrganizationEventKind = keyof typeof ORGANIZATION_EVENT_DEFINITIONS
export const ORGANIZATION_EVENT_KINDS = Object.keys(
	ORGANIZATION_EVENT_DEFINITIONS,
) as OrganizationEventKind[]

export function isOrganizationEventKind(
	value: unknown,
): value is OrganizationEventKind {
	return (
		typeof value === 'string' &&
		Object.prototype.hasOwnProperty.call(ORGANIZATION_EVENT_DEFINITIONS, value)
	)
}

/** The allowed payload keys of a kind. */
export function organizationEventPayloadKeys(
	kind: OrganizationEventKind,
): string[] {
	return Object.keys(ORGANIZATION_EVENT_DEFINITIONS[kind].payload.shape)
}

/**
 * Checks a payload against its kind's strict schema. Throws on a key outside
 * the allowlist (the writer catches it, logs the kind only and writes nothing).
 */
export function parseOrganizationEventPayload(
	kind: OrganizationEventKind,
	payload: unknown,
): Record<string, unknown> {
	return ORGANIZATION_EVENT_DEFINITIONS[kind].payload.parse(payload) as Record<
		string,
		unknown
	>
}

/** Reads a stored payload for display, keeping only the allowlisted keys. */
export function readStoredEventPayload(
	kind: string,
	raw: string | null | undefined,
): Record<string, unknown> {
	if (!isOrganizationEventKind(kind) || !raw) return {}
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object') return {}
		const allowed = new Set(organizationEventPayloadKeys(kind))
		return Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).filter(([key]) =>
				allowed.has(key),
			),
		)
	} catch {
		return {}
	}
}

/**
 * Timeline filters: the kinds a person picks from, across written events and
 * the ones read from audit rows, support requests and assignments.
 */
export const TIMELINE_FILTERS = [
	'plan',
	'launch',
	'payments',
	'domain',
	'texting',
	'billing',
	'integrations',
	'reminders',
	'ordering',
	'access',
	'support',
	'assignments',
	'notes',
] as const
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number]

export const TIMELINE_FILTER_LABELS: Record<TimelineFilter, string> = {
	plan: 'Plan and sign-up',
	launch: 'Launch',
	payments: 'Payments',
	domain: 'Domain',
	texting: 'Texting',
	billing: 'Billing',
	integrations: 'Integrations',
	reminders: 'Reminders',
	ordering: 'Ordering',
	access: 'Support access',
	support: 'Support requests',
	assignments: 'Assignments',
	notes: 'Notes',
}

export function isTimelineFilter(value: unknown): value is TimelineFilter {
	return (
		typeof value === 'string' &&
		(TIMELINE_FILTERS as readonly string[]).includes(value)
	)
}

export type TimelineLink = { label: string; href: string; external: boolean }

/**
 * Where an event is explained: Stripe's dashboard for a payout, invoice or
 * account, Admin's own screens for the rest. Never a guest record.
 */
export function organizationEventLink(
	kind: OrganizationEventKind,
	payload: Record<string, unknown>,
	organizationId: string,
): TimelineLink {
	const text = (key: string) =>
		typeof payload[key] === 'string' ? (payload[key] as string) : null
	const encode = encodeURIComponent
	switch (kind) {
		case 'payout_failed': {
			const payoutId = text('payoutId')
			return payoutId
				? {
						label: 'Open the payout in Stripe',
						href: `https://dashboard.stripe.com/payouts/${encode(payoutId)}`,
						external: true,
					}
				: overview(organizationId)
		}
		case 'payment_account_connected':
		case 'payment_account_needs_action': {
			const accountId = text('accountId')
			return accountId
				? {
						label: 'Open the account in Stripe',
						href: `https://dashboard.stripe.com/connect/accounts/${encode(accountId)}`,
						external: true,
					}
				: overview(organizationId)
		}
		case 'billing_payment_failed':
		case 'billing_payment_recovered': {
			const invoiceId = text('invoiceId')
			return invoiceId
				? {
						label: 'Open the invoice in Stripe',
						href: `https://dashboard.stripe.com/invoices/${encode(invoiceId)}`,
						external: true,
					}
				: overview(organizationId)
		}
		case 'launch_step_completed':
		case 'launch_live':
			return {
				label: 'Open the launch card',
				href: `/organizations/${encode(organizationId)}#launch`,
				external: false,
			}
		default:
			return overview(organizationId)
	}
}

function overview(organizationId: string): TimelineLink {
	return {
		label: 'Open the restaurant',
		href: `/organizations/${encodeURIComponent(organizationId)}`,
		external: false,
	}
}
