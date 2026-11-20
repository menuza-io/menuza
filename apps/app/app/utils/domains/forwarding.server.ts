import { AuditAction } from '@repo/audit'
import {
	emailConfirmationMatches,
	isSpf,
	type ZoneRecord,
} from '@repo/common/domain-zone'
import { trimDnsName } from '@repo/common/domains'
import {
	and,
	db,
	DomainEmailForward,
	eq,
	isNotNull,
	ManagedDomain,
} from '@repo/database'
import { logWebsiteActivity } from '#app/utils/website/activity.server.ts'
import { getDomainAdapters } from './adapters.select.server.ts'
import { notifyDomainEvent } from './notify.server.ts'
import {
	importProviderRecords,
	listDomainRecords,
	mergeSpfMechanism,
	removeRecordRow,
	replaceRecordRow,
	writeRecord,
	type ManagedDomainRow,
} from './zone.server.ts'

/**
 * Forwarding mail sent to a restaurant's domain to its own inbox (#276). Only
 * where Menuza hosts the domain's DNS; forwarding only (no mailbox, no
 * sending); at most 10 addresses; each destination confirms through the mail
 * provider's link first; and turning it on over an existing mail provider
 * needs the domain typed back. Message contents never pass through Menuza:
 * the routing provider forwards, we keep the rules.
 */

export const MAX_FORWARDS_PER_DOMAIN = 10

export type ForwardingFailure =
	| 'not_managed'
	| 'nameservers_pending'
	| 'mx_confirmation_required'
	| 'limit_reached'
	| 'invalid_address'
	| 'invalid_destination'
	| 'destination_on_domain'
	| 'duplicate'
	| 'not_found'
	| 'provider_failed'

export class ForwardingError extends Error {
	constructor(
		readonly code: ForwardingFailure,
		readonly detail?: unknown,
	) {
		super(code)
		this.name = 'ForwardingError'
	}
}

type Actor = { userId: string | null; request?: Request }
type ForwardRow = typeof DomainEmailForward.$inferSelect

const LOCAL_PART_RE = /^(?:\*|[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?)$/u
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/u

export function isValidLocalPart(value: string) {
	return LOCAL_PART_RE.test(value) && !value.includes('..')
}

async function log(
	organizationId: string,
	actor: Actor,
	details: string,
	metadata: Record<string, unknown>,
) {
	await logWebsiteActivity({
		action: AuditAction.WEBSITE_DOMAIN_CHANGED,
		organizationId,
		userId: actor.userId,
		details,
		metadata,
		request: actor.request,
	})
}

// ---------------------------------------------------------------------------
// Availability: why it can or cannot be used
// ---------------------------------------------------------------------------

export type ForwardingAvailability =
	| { available: true }
	| { available: false; reason: 'not_managed' | 'nameservers_pending' }

/**
 * Forwarding needs the domain's DNS to be ours: a zone we host that answers
 * for the domain (the registrar points at our nameservers, or we set them when
 * we registered it).
 */
export function forwardingAvailability(
	domain: Pick<ManagedDomainRow, 'zoneId' | 'zoneStatus' | 'source'> | null,
): ForwardingAvailability {
	if (!domain?.zoneId || domain.zoneStatus === 'none') {
		return { available: false, reason: 'not_managed' }
	}
	if (domain.zoneStatus === 'moved' || domain.zoneStatus === 'failed') {
		return { available: false, reason: 'not_managed' }
	}
	if (domain.zoneStatus !== 'active' && domain.source !== 'registered') {
		return { available: false, reason: 'nameservers_pending' }
	}
	return { available: true }
}

async function loadDomain(
	organizationId: string,
	managedDomainId: string,
): Promise<ManagedDomainRow> {
	const [row] = await db
		.select()
		.from(ManagedDomain)
		.where(
			and(
				eq(ManagedDomain.id, managedDomainId),
				eq(ManagedDomain.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!row) throw new ForwardingError('not_found')
	return row
}

export async function listForwards(managedDomainId: string) {
	const rows = await db
		.select()
		.from(DomainEmailForward)
		.where(eq(DomainEmailForward.managedDomainId, managedDomainId))
	return rows.sort((a, b) => a.localPart.localeCompare(b.localPart))
}

/** The mail records already on the domain that turning forwarding on would replace. */
export async function existingMailProvider(managedDomainId: string) {
	const records = await listDomainRecords(managedDomainId)
	return records
		.filter((row) => row.type === 'MX' && row.managedBy !== 'email_forwarding')
		.map((row) => ({ id: row.id, host: row.content, priority: row.priority }))
}

// ---------------------------------------------------------------------------
// Turning it on
// ---------------------------------------------------------------------------

const isForwardingManaged = (record: ZoneRecord) =>
	record.type === 'MX' &&
	trimDnsName(record.content).endsWith('.mx.cloudflare.net')
		? ('email_forwarding' as const)
		: null

export async function enableForwarding(input: {
	organizationId: string
	managedDomainId: string
	/** The domain typed back, needed when a mail provider is already set up. */
	mxConfirmation?: string | null
	actor: Actor
}): Promise<ManagedDomainRow> {
	const domain = await loadDomain(input.organizationId, input.managedDomainId)
	const availability = forwardingAvailability(domain)
	if (!availability.available) throw new ForwardingError(availability.reason)
	if (domain.emailForwardingEnabledAt) return domain

	const existing = await existingMailProvider(domain.id)
	if (
		existing.length > 0 &&
		!emailConfirmationMatches(input.mxConfirmation ?? '', domain.fqdn)
	) {
		throw new ForwardingError('mx_confirmation_required', existing)
	}
	const routing = getDomainAdapters().routing
	let enabled
	try {
		enabled = await routing.enable(domain.zoneId!, domain.fqdn)
	} catch {
		throw new ForwardingError('provider_failed')
	}
	// The old mailbox is cut off: its MX records go, the SPF record is kept and merged.
	for (const record of await listDomainRecords(domain.id)) {
		if (record.type === 'MX' && record.managedBy !== 'email_forwarding') {
			await removeRecordRow(domain, record)
		}
	}
	for (const record of enabled.records) {
		await writeRecord(
			domain,
			{ ...record, managedBy: 'email_forwarding' },
			'managed',
		)
	}
	await importProviderRecords(domain, isForwardingManaged)
	await mergeSpfMechanism(
		domain,
		domain.fqdn,
		enabled.spfInclude,
		'email_forwarding',
	)

	const now = new Date()
	const [updated] = await db
		.update(ManagedDomain)
		.set({
			emailForwardingEnabledAt: now,
			emailForwardingMxConfirmedAt: existing.length > 0 ? now : null,
		})
		.where(eq(ManagedDomain.id, domain.id))
		.returning()
	await log(
		input.organizationId,
		input.actor,
		existing.length > 0
			? `Turned on email forwarding for ${domain.fqdn}, replacing its existing mail provider.`
			: `Turned on email forwarding for ${domain.fqdn}.`,
		{
			domain: domain.fqdn,
			change: 'forwarding_on',
			replacedMx: existing.map((m) => m.host),
		},
	)
	return updated!
}

export async function disableForwarding(input: {
	organizationId: string
	managedDomainId: string
	actor: Actor
}) {
	const domain = await loadDomain(input.organizationId, input.managedDomainId)
	if (!domain.emailForwardingEnabledAt) return domain
	const routing = getDomainAdapters().routing
	await routing.disable(domain.zoneId!).catch(() => undefined)
	await db
		.delete(DomainEmailForward)
		.where(eq(DomainEmailForward.managedDomainId, domain.id))
	for (const record of await listDomainRecords(domain.id)) {
		if (record.managedBy === 'email_forwarding') {
			await removeRecordRow(domain, record)
		} else if (record.type === 'TXT' && isSpf(record.content)) {
			// Take our sender out of the operator's SPF record again.
			const without = record.content
				.split(/\s+/u)
				.filter(
					(part) => part.toLowerCase() !== routing.spfInclude.toLowerCase(),
				)
				.join(' ')
			if (without !== record.content)
				await replaceRecordRow(domain, record, { content: without })
		}
	}
	const [updated] = await db
		.update(ManagedDomain)
		.set({ emailForwardingEnabledAt: null, emailForwardingMxConfirmedAt: null })
		.where(eq(ManagedDomain.id, domain.id))
		.returning()
	await log(
		input.organizationId,
		input.actor,
		`Turned off email forwarding for ${domain.fqdn}.`,
		{
			domain: domain.fqdn,
			change: 'forwarding_off',
		},
	)
	return updated!
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export async function addForward(input: {
	organizationId: string
	managedDomainId: string
	localPart: string
	destination: string
	mxConfirmation?: string | null
	actor: Actor
}): Promise<ForwardRow> {
	const localPart = input.localPart.trim().toLowerCase()
	const destination = input.destination.trim().toLowerCase()
	if (!isValidLocalPart(localPart)) throw new ForwardingError('invalid_address')
	if (!EMAIL_RE.test(destination) || destination.length > 254) {
		throw new ForwardingError('invalid_destination')
	}
	let domain = await loadDomain(input.organizationId, input.managedDomainId)
	const availability = forwardingAvailability(domain)
	if (!availability.available) throw new ForwardingError(availability.reason)
	if (destination.endsWith(`@${domain.fqdn}`))
		throw new ForwardingError('destination_on_domain')

	const existing = await listForwards(domain.id)
	if (existing.some((row) => row.localPart === localPart))
		throw new ForwardingError('duplicate')
	if (existing.length >= MAX_FORWARDS_PER_DOMAIN)
		throw new ForwardingError('limit_reached')

	if (!domain.emailForwardingEnabledAt) {
		domain = await enableForwarding({
			organizationId: input.organizationId,
			managedDomainId: domain.id,
			mxConfirmation: input.mxConfirmation,
			actor: input.actor,
		})
	}
	const routing = getDomainAdapters().routing
	let verified: boolean
	try {
		verified = (await routing.addDestination(destination)).verified
	} catch {
		throw new ForwardingError('provider_failed')
	}
	const [row] = await db
		.insert(DomainEmailForward)
		.values({
			managedDomainId: domain.id,
			localPart,
			destination,
			status: 'pending_confirmation',
			createdById: input.actor.userId,
		})
		.returning()
	await log(
		input.organizationId,
		input.actor,
		`Added the forwarding address ${localPart === '*' ? `anything@${domain.fqdn}` : `${localPart}@${domain.fqdn}`}.`,
		{ domain: domain.fqdn, change: 'forward_add', localPart },
	)
	// A destination that already confirmed (used before) starts forwarding at once.
	return verified ? ((await activateForward(domain, row!)) ?? row!) : row!
}

async function activateForward(
	domain: ManagedDomainRow,
	row: ForwardRow,
): Promise<ForwardRow | null> {
	const routing = getDomainAdapters().routing
	try {
		const rule = await routing.upsertRule({
			zoneId: domain.zoneId!,
			domain: domain.fqdn,
			localPart: row.localPart,
			destination: row.destination,
			ruleId: row.providerRuleId,
		})
		const [updated] = await db
			.update(DomainEmailForward)
			.set({ status: 'active', providerRuleId: rule.ruleId, lastError: null })
			.where(eq(DomainEmailForward.id, row.id))
			.returning()
		return updated ?? null
	} catch (error) {
		const [updated] = await db
			.update(DomainEmailForward)
			.set({
				status: 'failing',
				lastError:
					error instanceof Error
						? error.message.slice(0, 120)
						: 'provider_error',
			})
			.where(eq(DomainEmailForward.id, row.id))
			.returning()
		return updated ?? null
	}
}

export async function removeForward(input: {
	organizationId: string
	managedDomainId: string
	forwardId: string
	actor: Actor
}) {
	const domain = await loadDomain(input.organizationId, input.managedDomainId)
	const [row] = await db
		.select()
		.from(DomainEmailForward)
		.where(
			and(
				eq(DomainEmailForward.id, input.forwardId),
				eq(DomainEmailForward.managedDomainId, domain.id),
			),
		)
		.limit(1)
	if (!row) throw new ForwardingError('not_found')
	if (row.providerRuleId && domain.zoneId) {
		await getDomainAdapters()
			.routing.removeRule(domain.zoneId, row.providerRuleId, row.localPart)
			.catch(() => undefined)
	}
	await db.delete(DomainEmailForward).where(eq(DomainEmailForward.id, row.id))
	await log(
		input.organizationId,
		input.actor,
		`Removed the forwarding address ${row.localPart}@${domain.fqdn}.`,
		{
			domain: domain.fqdn,
			change: 'forward_remove',
			localPart: row.localPart,
		},
	)
}

/** Sends the destination's confirmation email again. */
export async function resendConfirmation(input: {
	organizationId: string
	managedDomainId: string
	forwardId: string
}) {
	const domain = await loadDomain(input.organizationId, input.managedDomainId)
	const [row] = await db
		.select()
		.from(DomainEmailForward)
		.where(
			and(
				eq(DomainEmailForward.id, input.forwardId),
				eq(DomainEmailForward.managedDomainId, domain.id),
			),
		)
		.limit(1)
	if (!row) throw new ForwardingError('not_found')
	await getDomainAdapters().routing.addDestination(row.destination)
}

/**
 * Looks at every address of a domain: a destination that confirmed starts
 * forwarding; one the provider lost or refused shows as failing and the
 * operator is told once; the last time mail was forwarded is read when the
 * provider reports it.
 */
export async function refreshForwarding(domain: ManagedDomainRow) {
	const routing = getDomainAdapters().routing
	const counts = { activated: 0, failing: 0 }
	if (!domain.emailForwardingEnabledAt || !domain.zoneId) return counts
	for (const row of await listForwards(domain.id)) {
		const destination = await routing
			.getDestination(row.destination)
			.catch(() => null)
		if (row.status === 'pending_confirmation' || row.status === 'failing') {
			if (destination?.verified) {
				const updated = await activateForward(domain, row)
				if (updated?.status === 'active') counts.activated += 1
			}
			continue
		}
		if (row.status === 'active') {
			if (destination && !destination.verified) {
				await db
					.update(DomainEmailForward)
					.set({ status: 'failing', lastError: 'destination_unverified' })
					.where(eq(DomainEmailForward.id, row.id))
				counts.failing += 1
				await notifyDomainEvent({
					organizationId: domain.organizationId,
					kind: 'forwarding_failing',
					entityId: `${row.id}:${Date.now() - (Date.now() % 86_400_000)}`,
					host: domain.fqdn,
				})
				continue
			}
			if (row.providerRuleId && routing.lastForwardedAt) {
				const last = await routing
					.lastForwardedAt(domain.zoneId, row.providerRuleId)
					.catch(() => null)
				if (last && (!row.lastForwardedAt || last > row.lastForwardedAt)) {
					await db
						.update(DomainEmailForward)
						.set({ lastForwardedAt: last })
						.where(eq(DomainEmailForward.id, row.id))
				}
			}
		}
	}
	return counts
}

export async function sweepForwarding() {
	const domains = await db
		.select()
		.from(ManagedDomain)
		.where(isNotNull(ManagedDomain.emailForwardingEnabledAt))
		.limit(200)
	const totals = { activated: 0, failing: 0 }
	for (const domain of domains) {
		const counts = await refreshForwarding(domain).catch(() => ({
			activated: 0,
			failing: 0,
		}))
		totals.activated += counts.activated
		totals.failing += counts.failing
	}
	return totals
}
