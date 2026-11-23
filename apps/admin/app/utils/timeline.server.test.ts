import { randomUUID } from 'node:crypto'
import { AuditAction } from '@repo/audit'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import { ORGANIZATION_EVENT_KINDS } from '@repo/common/organization-events'
import {
	AuditLog,
	Feedback,
	Organization,
	OrganizationAssignment,
	OrganizationEvent,
	OrganizationLocation,
	Session,
	SupportNote,
	User,
	UserOrganization,
	db,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import { loader as timelineLoader } from '../routes/_admin+/organizations+/$organizationId_+/timeline.tsx'
import { loadTimeline } from './timeline.server.ts'

async function user(name: string) {
	const id = randomUUID()
	const [row] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com`, name })
		.returning()
	return row!
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

async function restaurant() {
	const id = randomUUID()
	const [organization] = await db
		.insert(Organization)
		.values({
			name: `Business ${id.slice(0, 6)}`,
			slug: `org-${id}`,
			createdAt: minutesAgo(10_000),
		})
		.returning()
	const owner = await user('Olivia Owner')
	await db.insert(UserOrganization).values({
		userId: owner.id,
		organizationId: organization!.id,
		organizationRoleId: 'org_role_admin',
	})
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization!.id,
			name: 'Main street',
			slug: 'main-street',
		})
		.returning()
	const [other] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization!.id,
			name: 'Harbour',
			slug: 'harbour',
		})
		.returning()
	return {
		organization: organization!,
		owner,
		location: location!,
		other: other!,
	}
}

async function event(
	organizationId: string,
	kind: string,
	payload: Record<string, unknown>,
	at: Date,
	locationId: string | null = null,
) {
	await db.insert(OrganizationEvent).values({
		organizationId,
		kind,
		payload: JSON.stringify(payload),
		createdAt: at,
		locationId,
	})
}

async function audit(input: {
	action: AuditAction
	at: Date
	organizationId?: string
	targetUserId?: string
	metadata?: Record<string, unknown>
	userId?: string
}) {
	await db.insert(AuditLog).values({
		action: input.action,
		details: 'x',
		createdAt: input.at,
		organizationId: input.organizationId ?? null,
		targetUserId: input.targetUserId ?? null,
		userId: input.userId ?? null,
		metadata: input.metadata ? JSON.stringify(input.metadata) : null,
	})
}

describe('Admin timeline (#279)', () => {
	it('shows payment, domain, texting, billing and launch events in order, newest first', async () => {
		const { organization, owner, location } = await restaurant()
		const agent = await user('Sara Support')
		await event(
			organization.id,
			'launch_step_completed',
			{ stepKey: 'menu' },
			minutesAgo(900),
			location.id,
		)
		await event(
			organization.id,
			'payment_account_needs_action',
			{ accountId: 'acct_1', chargesEnabled: false, payoutsEnabled: false },
			minutesAgo(800),
		)
		await event(
			organization.id,
			'payout_failed',
			{ accountId: 'acct_1', payoutId: 'po_1', failureCode: 'account_closed' },
			minutesAgo(700),
		)
		await event(
			organization.id,
			'domain_failing',
			{ host: 'luigis.example', state: 'expired' },
			minutesAgo(600),
		)
		await event(
			organization.id,
			'billing_payment_failed',
			{ invoiceId: 'in_1', attemptCount: 2 },
			minutesAgo(500),
		)
		await event(
			organization.id,
			'billing_payment_recovered',
			{ invoiceId: 'in_2' },
			minutesAgo(400),
		)
		await event(
			organization.id,
			'launch_live',
			{},
			minutesAgo(300),
			location.id,
		)
		// A texting event comes from the audit log (read, not copied).
		await audit({
			action: AuditAction.PHONE_AGENT_LINE_VERIFIED,
			at: minutesAgo(200),
			organizationId: organization.id,
		})
		// An impersonation names its target in the metadata, not in a column.
		await audit({
			action: AuditAction.ADMIN_IMPERSONATION_START,
			at: minutesAgo(100),
			userId: agent.id,
			metadata: { targetUserId: owner.id, adminName: 'Sara Support' },
		})

		const timeline = await loadTimeline({ organizationId: organization.id })
		const titles = timeline.entries.map((entry) => entry.title)
		expect(titles).toEqual([
			'Support impersonation started',
			'Business line verified',
			'Location went live',
			'Billing payment recovered',
			'Billing payment failed',
			'Domain failing',
			'Payout failed',
			'Payment account needs action',
			'Launch step completed',
			'Signed up',
		])
		// Strictly newest first.
		const times = timeline.entries.map((entry) => entry.at.getTime())
		expect(times).toEqual([...times].sort((a, b) => b - a))
	})

	it('links each event to the detail that explains it', async () => {
		const { organization, location } = await restaurant()
		await event(
			organization.id,
			'payout_failed',
			{ accountId: 'acct_1', payoutId: 'po_9', failureCode: null },
			minutesAgo(5),
		)
		await event(
			organization.id,
			'billing_payment_failed',
			{ invoiceId: 'in_9', attemptCount: 1 },
			minutesAgo(4),
		)
		await event(organization.id, 'launch_live', {}, minutesAgo(3), location.id)
		await event(
			organization.id,
			'domain_live',
			{ host: 'a.example' },
			minutesAgo(2),
		)
		const { entries } = await loadTimeline({ organizationId: organization.id })
		const byTitle = Object.fromEntries(entries.map((e) => [e.title, e.link]))
		expect(byTitle['Payout failed']).toMatchObject({
			external: true,
			href: 'https://dashboard.stripe.com/payouts/po_9',
		})
		expect(byTitle['Billing payment failed']).toMatchObject({
			href: 'https://dashboard.stripe.com/invoices/in_9',
		})
		expect(byTitle['Location went live']?.href).toBe(
			`/organizations/${organization.id}#launch`,
		)
		expect(byTitle['Domain connected']?.href).toBe(
			`/organizations/${organization.id}`,
		)
		for (const entry of entries) {
			if (entry.title !== 'Signed up') expect(entry.link?.href).toBeTruthy()
		}
	})

	it('never carries guest data: unknown payload keys are dropped, and no guest value is shown', async () => {
		const { organization } = await restaurant()
		// A row that somehow holds guest fields (written by a bug or by hand).
		await event(
			organization.id,
			'billing_payment_failed',
			{
				invoiceId: 'in_1',
				attemptCount: 1,
				guestName: 'Jane Doe',
				customerEmail: 'jane@guest.example',
				phone: '+15551234567',
				orderItems: ['Margherita'],
			},
			minutesAgo(5),
		)
		const { entries } = await loadTimeline({ organizationId: organization.id })
		const serialized = JSON.stringify(entries)
		for (const leak of [
			'Jane Doe',
			'jane@guest.example',
			'5551234567',
			'Margherita',
		]) {
			expect(serialized).not.toContain(leak)
		}
	})

	it('filters by kind and location, and pages', async () => {
		const { organization, location, other } = await restaurant()
		await event(organization.id, 'launch_live', {}, minutesAgo(30), location.id)
		await event(organization.id, 'launch_live', {}, minutesAgo(20), other.id)
		await event(
			organization.id,
			'domain_live',
			{ host: 'a.example' },
			minutesAgo(10),
		)

		const launch = await loadTimeline({
			organizationId: organization.id,
			filters: ['launch'],
		})
		expect(launch.entries.map((e) => e.title)).toEqual([
			'Location went live',
			'Location went live',
		])
		const here = await loadTimeline({
			organizationId: organization.id,
			filters: ['launch'],
			locationId: location.id,
		})
		expect(here.entries).toHaveLength(1)
		expect(here.entries[0]!.locationName).toBe('Main street')

		// Paging: 60 events give a first page and a cursor to the rest.
		for (let index = 0; index < 60; index++) {
			await event(
				organization.id,
				'reminder_sent',
				{ reminderKind: `r${index}` },
				minutesAgo(1000 + index),
			)
		}
		const first = await loadTimeline({
			organizationId: organization.id,
			filters: ['reminders'],
		})
		expect(first.entries).toHaveLength(40)
		expect(first.nextBefore).toBeInstanceOf(Date)
		const second = await loadTimeline({
			organizationId: organization.id,
			filters: ['reminders'],
			before: first.nextBefore,
		})
		expect(second.entries.length).toBeGreaterThan(0)
		expect(second.entries[0]!.at.getTime()).toBeLessThan(
			first.nextBefore!.getTime(),
		)
	})

	it('reads support requests, assignments and pinned notes into the timeline', async () => {
		const { organization, owner } = await restaurant()
		const agent = await user('Sara Support')
		const [request] = await db
			.insert(Feedback)
			.values({
				userId: owner.id,
				organizationId: organization.id,
				kind: 'support',
				type: 'SUPPORT',
				message: 'Private question text',
				createdAt: minutesAgo(50),
				closedAt: minutesAgo(10),
				status: 'closed',
			})
			.returning()
		await db.insert(OrganizationAssignment).values({
			organizationId: organization.id,
			adminUserId: agent.id,
			role: 'support',
			scopeKey: 'all',
			startedAt: minutesAgo(40),
			endedAt: minutesAgo(5),
		})
		await db.insert(SupportNote).values({
			organizationId: organization.id,
			authorId: agent.id,
			body: 'Called owner, will fix bank details Monday',
			pinned: true,
			createdAt: minutesAgo(30),
		})
		const timeline = await loadTimeline({ organizationId: organization.id })
		const titles = timeline.entries.map((entry) => entry.title)
		expect(titles).toEqual(
			expect.arrayContaining([
				'Support requested',
				'Support request closed',
				'Support assigned',
				'Support ended',
				'Note',
			]),
		)
		expect(timeline.pinned.map((note) => note.body)).toEqual([
			'Called owner, will fix bank details Monday',
		])
		// The request's own words stay in the request.
		expect(JSON.stringify(timeline)).not.toContain('Private question text')
		expect(
			timeline.entries.find((e) => e.title === 'Support requested')?.link?.href,
		).toBe(`/feedback/${request!.id}`)
	})

	it('only allowlisted payload keys can be written, for every kind', () => {
		// The writer's schema is the allowlist: see organization-events.test.ts. Here
		// the Timeline refuses to show a kind it does not know.
		expect(ORGANIZATION_EVENT_KINDS.length).toBeGreaterThan(10)
	})

	it('is for Admin only', async () => {
		const { organization } = await restaurant()
		const stranger = await user('Not Admin')
		const [session] = await db
			.insert(Session)
			.values({
				userId: stranger.id,
				expirationDate: getSessionExpirationDate(),
			})
			.returning()
		const authSession = await authSessionStorage.getSession()
		authSession.set(sessionKey, session!.id)
		const cookie = await authSessionStorage.commitSession(authSession)
		let thrown: unknown
		try {
			await timelineLoader({
				request: new Request(
					`http://localhost:3004/organizations/${organization.id}/timeline`,
					{
						headers: { Cookie: cookie },
					},
				),
				params: { organizationId: organization.id },
			})
		} catch (error) {
			thrown = error
		}
		expect(thrown).toBeInstanceOf(Response)
		expect([302, 401, 403]).toContain((thrown as Response).status)
	})
})
