import { AuditAction } from '@repo/audit'
import {
	describeHostname,
	isReservedHostname,
	parseHostname,
} from '@repo/common/domains'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	and,
	db,
	DomainCharge,
	DomainJob,
	eq,
	inArray,
	ManagedDomain,
	Organization,
	OrganizationLocation,
	SiteDomain,
	sql,
} from '@repo/database'
import { decrypt, encrypt, getEncryptionKey } from '@repo/security'
import { logWebsiteActivity } from '#app/utils/website/activity.server.ts'
import { getDomainAdapters } from './adapters.select.server.ts'
import {
	RegistrarError,
	type DomainAvailability,
	type RegistrantContact,
} from './adapters.server.ts'
import {
	domainMarkupPercent,
	platformDomains,
	supportedTlds,
} from './config.server.ts'
import { notifyDomainEvent } from './notify.server.ts'
import { getDomainPayments } from './payments.server.ts'
import { parseRegistrantContact } from './registrant.ts'
import {
	addSiteDomains,
	checkAndNotify,
	ensureSiteDomains,
	primaryOf,
} from './site-domains.server.ts'
import { syncSiteRecords } from './zone.server.ts'

/**
 * Buying and keeping a domain inside Menuza (#183): search with prices and
 * suggestions, buy with the card on file, register in a background job with
 * a refund when it fails, renewals with reminders and card retries, and the
 * transfers. The registrar and Stripe sit behind adapters; the organization is
 * the registrant and its contact is stored encrypted.
 */

export const DOMAINS_REGISTRAR_FLAG = 'domains.registrar'
export const TRANSFER_LOCK_DAYS = 60
export const RENEWAL_LEAD_DAYS = 3
export const RENEWAL_RETRY_DAYS = 7
export const MAX_JOB_ATTEMPTS = 5
const DAY = 86_400_000

export type RegistrarFailure =
	| 'feature_off'
	| 'not_configured'
	| 'domain_unavailable'
	| 'tld_not_supported'
	| 'hostname_invalid'
	| 'hostname_reserved'
	| 'hostname_taken'
	| 'price_changed'
	| 'no_card_on_file'
	| 'payment_failed'
	| 'card_declined'
	| 'invalid_contact'
	| 'not_found'
	| 'too_new'
	| 'locked'
	| 'invalid_auth_code'
	| 'transfer_failed'
	| 'not_active'

export class RegistrarFlowError extends Error {
	constructor(
		readonly code: RegistrarFailure,
		readonly detail?: unknown,
	) {
		super(code)
		this.name = 'RegistrarFlowError'
	}
}

export async function isRegistrarEnabled(organizationId: string) {
	return (
		(await getFeatureFlag(DOMAINS_REGISTRAR_FLAG, { organizationId })) === true
	)
}

async function requireRegistrar(organizationId: string) {
	if (!(await isRegistrarEnabled(organizationId))) {
		throw new RegistrarFlowError('feature_off')
	}
	const registrar = getDomainAdapters().registrar
	if (!registrar.isConfigured()) throw new RegistrarFlowError('not_configured')
	return registrar
}

type Actor = { userId: string | null; request?: Request }

async function logRegistrar(
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
// Search and prices
// ---------------------------------------------------------------------------

/** What the restaurant pays for one year: our cost plus the markup, in cents. */
export function retailCents(
	costCents: number,
	markupPercent = domainMarkupPercent(),
) {
	return Math.round(costCents * (1 + markupPercent / 100))
}

export type DomainOffer = {
	fqdn: string
	available: boolean
	/** Offered for sale: available and not a premium name. */
	buyable: boolean
	premium: boolean
	priceCents: number
	renewalCents: number
	currency: string
	suggestion: boolean
}

const MAX_CANDIDATES = 24

function label(value: string) {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/gu, '')
		.slice(0, 40)
}

/** Takes the city out of a free-text address: the part before the country. */
export function cityFromAddress(
	address: string | null | undefined,
): string | null {
	const parts = (address ?? '')
		.split(',')
		.map((part) => part.replace(/[0-9]/gu, '').trim())
		.filter(Boolean)
	if (parts.length < 2) return null
	return parts[parts.length - 2] ?? null
}

/**
 * Names to offer from the restaurant's name and city: `albaitriyadh`,
 * `eatalbait`, `albaitmenu`. Letters and digits only, one label.
 */
export function suggestionLabels(name: string, city: string | null): string[] {
	const base = label(name)
	if (!base) return []
	const place = city ? label(city) : ''
	return [
		...new Set(
			[
				place ? `${base}${place}` : '',
				`eat${base}`,
				`${base}restaurant`,
				`${base}menu`,
				`order${base}`,
				`${base}kitchen`,
				place ? `${base}-${place}` : '',
			].filter((candidate) => candidate && candidate.length >= 3),
		),
	]
}

export async function searchDomains(input: {
	organizationId: string
	query: string
	city?: string | null
}): Promise<{
	query: string
	results: DomainOffer[]
	suggestions: DomainOffer[]
}> {
	const registrar = await requireRegistrar(input.organizationId)
	const tlds = supportedTlds()
	const raw =
		input.query
			.trim()
			.toLowerCase()
			.replace(/^https?:\/\//u, '')
			.split('/')[0] ?? ''
	if (!raw) throw new RegistrarFlowError('hostname_invalid')

	let typedLabel = raw
	let typedTld: string | null = null
	if (raw.includes('.')) {
		const parts = describeHostname(raw.replace(/^www\./u, ''))
		if (!parts) throw new RegistrarFlowError('hostname_invalid')
		typedLabel = parts.apex.slice(0, -(parts.publicSuffix.length + 1))
		typedTld = parts.publicSuffix
	}
	typedLabel = label(typedLabel) || typedLabel.replace(/[^a-z0-9-]/gu, '')
	if (!typedLabel) throw new RegistrarFlowError('hostname_invalid')
	if (typedTld && !tlds.includes(typedTld)) {
		throw new RegistrarFlowError('tld_not_supported', { tld: typedTld })
	}

	const [org] = await db
		.select({ name: Organization.name })
		.from(Organization)
		.where(eq(Organization.id, input.organizationId))
		.limit(1)
	let city = input.city?.trim() || null
	if (!city) {
		const [location] = await db
			.select({ address: OrganizationLocation.address })
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, input.organizationId))
			.limit(1)
		city = cityFromAddress(location?.address)
	}
	const typedNames = (typedTld ? [typedTld] : tlds).map(
		(tld) => `${typedLabel}.${tld}`,
	)
	const suggested = suggestionLabels(org?.name ?? typedLabel, city)
		.flatMap((candidate) => tlds.map((tld) => `${candidate}.${tld}`))
		.filter((name) => !typedNames.includes(name))
	const names = [...typedNames, ...suggested].slice(0, MAX_CANDIDATES)

	const availability = await registrar.checkAvailability(names)
	const offer = (
		entry: DomainAvailability,
		suggestion: boolean,
	): DomainOffer => ({
		fqdn: entry.fqdn,
		available: entry.available,
		buyable: entry.available && !entry.premium,
		premium: entry.premium,
		priceCents: retailCents(entry.costCents),
		renewalCents: retailCents(entry.renewalCostCents),
		currency: entry.currency,
		suggestion,
	})
	const byName = new Map(availability.map((entry) => [entry.fqdn, entry]))
	const results = typedNames.flatMap((name) => {
		const entry = byName.get(name)
		return entry ? [offer(entry, false)] : []
	})
	const suggestions = suggested
		.flatMap((name) => {
			const entry = byName.get(name)
			return entry?.available ? [offer(entry, true)] : []
		})
		.slice(0, 8)
	return { query: typedLabel, results, suggestions }
}

// ---------------------------------------------------------------------------
// Contact storage
// ---------------------------------------------------------------------------

export function sealContact(contact: RegistrantContact): string {
	return encrypt(JSON.stringify(contact), getEncryptionKey())
}

export function openContact(sealed: string | null): RegistrantContact | null {
	if (!sealed) return null
	try {
		return JSON.parse(decrypt(sealed, getEncryptionKey())) as RegistrantContact
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

type JobRow = typeof DomainJob.$inferSelect
type ManagedRow = typeof ManagedDomain.$inferSelect
type ChargeRow = typeof DomainCharge.$inferSelect

function assertBuyable(fqdn: string) {
	const parsed = parseHostname(fqdn)
	if (!parsed.ok) throw new RegistrarFlowError('hostname_invalid')
	const parts = describeHostname(parsed.hostname)
	if (!parts || parts.role !== 'apex')
		throw new RegistrarFlowError('hostname_invalid')
	if (!supportedTlds().includes(parts.publicSuffix)) {
		throw new RegistrarFlowError('tld_not_supported', {
			tld: parts.publicSuffix,
		})
	}
	if (isReservedHostname(parsed.hostname, platformDomains())) {
		throw new RegistrarFlowError('hostname_reserved')
	}
	return parsed.hostname
}

async function assertNameFree(fqdn: string, organizationId: string) {
	// A failed purchase left nothing behind; anything else holds the name.
	const [managed] = await db
		.select({ organizationId: ManagedDomain.organizationId })
		.from(ManagedDomain)
		.where(eq(ManagedDomain.fqdn, fqdn))
		.limit(1)
	if (managed) throw new RegistrarFlowError('hostname_taken')
	const [site] = await db
		.select({ organizationId: SiteDomain.organizationId })
		.from(SiteDomain)
		.where(
			and(
				eq(SiteDomain.hostname, fqdn),
				sql`${SiteDomain.status} <> 'expired'`,
			),
		)
		.limit(1)
	if (site && site.organizationId !== organizationId) {
		throw new RegistrarFlowError('hostname_taken')
	}
}

export type StartPurchaseInput = {
	organization: { id: string; slug: string; name: string }
	fqdn: string
	contact: unknown
	/** The yearly price the operator was shown; a different current price asks again. */
	acceptedPriceCents: number
	years?: number
	actor: Actor
}

/**
 * Re-checks the name right before charging (taken in between: no charge),
 * charges the card on file, and queues the registration. The progress screen
 * follows the job; a failed registration refunds the charge.
 */
export async function startPurchase(input: StartPurchaseInput) {
	const registrar = await requireRegistrar(input.organization.id)
	const fqdn = assertBuyable(input.fqdn)
	const contact = parseRegistrantContact(input.contact)
	if (!contact.success) {
		throw new RegistrarFlowError(
			'invalid_contact',
			contact.error.issues.map((i) => i.path.join('.')),
		)
	}
	const years = input.years ?? 1
	await assertNameFree(fqdn, input.organization.id)

	const [fresh] = await registrar.checkAvailability([fqdn])
	if (!fresh || !fresh.available || fresh.premium) {
		throw new RegistrarFlowError('domain_unavailable')
	}
	const amountCents = retailCents(fresh.costCents) * years
	if (amountCents !== input.acceptedPriceCents * years) {
		throw new RegistrarFlowError('price_changed', {
			priceCents: retailCents(fresh.costCents),
		})
	}
	const payments = getDomainPayments()
	if (!(await payments.hasCardOnFile(input.organization.id))) {
		throw new RegistrarFlowError('no_card_on_file')
	}

	let managed: ManagedRow
	try {
		const [row] = await db
			.insert(ManagedDomain)
			.values({
				organizationId: input.organization.id,
				fqdn,
				source: 'registered',
				registrar: registrar.name,
				registrationStatus: 'pending',
				zoneStatus: 'pending',
				autoRenew: true,
				locked: true,
				privacy: true,
				registrantContact: sealContact(contact.data),
			})
			.returning()
		managed = row!
	} catch {
		throw new RegistrarFlowError('hostname_taken')
	}
	const [job] = await db
		.insert(DomainJob)
		.values({
			organizationId: input.organization.id,
			managedDomainId: managed.id,
			kind: 'register',
			status: 'queued',
			step: 'charging',
			idempotencyKey: `register:${managed.id}`,
			params: JSON.stringify({ fqdn, years, priceCents: amountCents }),
			createdById: input.actor.userId,
		})
		.returning()
	const [charge] = await db
		.insert(DomainCharge)
		.values({
			organizationId: input.organization.id,
			managedDomainId: managed.id,
			jobId: job!.id,
			kind: 'registration',
			amountCents,
			idempotencyKey: `${job!.idempotencyKey}:charge`,
		})
		.returning()

	const paid = await payments.charge({
		organizationId: input.organization.id,
		amountCents,
		currency: 'usd',
		idempotencyKey: charge!.idempotencyKey,
		description: `Domain registration: ${fqdn}`,
		metadata: {
			type: 'domain_registration',
			organizationId: input.organization.id,
			jobId: job!.id,
		},
	})
	if (paid.status === 'failed') {
		await db
			.update(DomainCharge)
			.set({ status: 'failed', failureCode: paid.code })
			.where(eq(DomainCharge.id, charge!.id))
		await db
			.update(DomainJob)
			.set({
				managedDomainId: null,
				status: 'failed',
				error: paid.code,
				completedAt: new Date(),
			})
			.where(eq(DomainJob.id, job!.id))
		await db.delete(ManagedDomain).where(eq(ManagedDomain.id, managed.id))
		throw new RegistrarFlowError(
			paid.code === 'no_card_on_file' ? 'no_card_on_file' : paid.code,
		)
	}
	await db
		.update(DomainCharge)
		.set({ status: 'succeeded', stripePaymentIntentId: paid.paymentIntentId })
		.where(eq(DomainCharge.id, charge!.id))
	await db
		.update(DomainJob)
		.set({ step: 'registering' })
		.where(eq(DomainJob.id, job!.id))
	await logRegistrar(
		input.organization.id,
		input.actor,
		`Bought the domain ${fqdn}.`,
		{ domain: fqdn, amountCents, jobId: job!.id },
	)
	return { jobId: job!.id, managedDomainId: managed.id, amountCents }
}

// ---------------------------------------------------------------------------
// The registration job
// ---------------------------------------------------------------------------

async function refundCharge(charge: ChargeRow, now: Date): Promise<boolean> {
	if (charge.status === 'refunded' || !charge.stripePaymentIntentId) return true
	try {
		const refund = await getDomainPayments().refund({
			paymentIntentId: charge.stripePaymentIntentId,
			amountCents: charge.amountCents,
			idempotencyKey: `${charge.idempotencyKey}:refund`,
		})
		await db
			.update(DomainCharge)
			.set({
				status: 'refunded',
				stripeRefundId: refund.refundId,
				refundedAt: now,
			})
			.where(eq(DomainCharge.id, charge.id))
		return true
	} catch {
		await db
			.update(DomainCharge)
			.set({ status: 'refund_failed' })
			.where(eq(DomainCharge.id, charge.id))
		return false
	}
}

/** A failed registration: refund in full, free the name, tell the operator. */
async function failRegistration(
	job: JobRow,
	managed: ManagedRow | null,
	code: string,
	now: Date,
) {
	const charges = await db
		.select()
		.from(DomainCharge)
		.where(eq(DomainCharge.jobId, job.id))
	for (const charge of charges) await refundCharge(charge, now)
	await db
		.update(DomainJob)
		.set({
			status: 'failed',
			error: code,
			managedDomainId: null,
			completedAt: now,
		})
		.where(eq(DomainJob.id, job.id))
	if (managed) {
		if (managed.zoneId) {
			await getDomainAdapters()
				.dns.deleteZone(managed.zoneId)
				.catch(() => undefined)
		}
		await db.delete(ManagedDomain).where(eq(ManagedDomain.id, managed.id))
	}
	const fqdn =
		(JSON.parse(job.params ?? '{}') as { fqdn?: string }).fqdn ??
		managed?.fqdn ??
		''
	await notifyDomainEvent({
		organizationId: job.organizationId,
		kind: 'registration_failed',
		entityId: job.id,
		host: fqdn,
		userIds: job.createdById ? [job.createdById] : undefined,
	})
}

/**
 * Runs one registration job step by step, safe to run again after any crash:
 * the zone, the registration, the site hosts. A refusal from the registry
 * refunds; a provider that is down is retried with a delay and, after five
 * attempts, refunds too.
 */
export async function processRegistrationJob(
	jobId: string,
	options: { now?: Date } = {},
) {
	const now = options.now ?? new Date()
	const [claimed] = await db
		.update(DomainJob)
		.set({ status: 'running', attempts: sql`${DomainJob.attempts} + 1` })
		.where(
			and(
				eq(DomainJob.id, jobId),
				eq(DomainJob.kind, 'register'),
				inArray(DomainJob.status, ['queued']),
				sql`${DomainJob.runAfter} <= ${now.getTime()}`,
			),
		)
		.returning()
	if (!claimed) return 'skipped' as const
	const [managed] = claimed.managedDomainId
		? await db
				.select()
				.from(ManagedDomain)
				.where(eq(ManagedDomain.id, claimed.managedDomainId))
				.limit(1)
		: []
	if (!managed) {
		await failRegistration(claimed, null, 'domain_missing', now)
		return 'failed' as const
	}
	const adapters = getDomainAdapters()
	try {
		let current = managed
		if (!current.zoneId) {
			await db
				.update(DomainJob)
				.set({ step: 'zone' })
				.where(eq(DomainJob.id, jobId))
			const zone = await adapters.dns.createZone(current.fqdn)
			const [updated] = await db
				.update(ManagedDomain)
				.set({
					zoneProvider: adapters.dns.name,
					zoneId: zone.zoneId,
					nameservers: JSON.stringify(zone.nameservers),
					zoneStatus: zone.status === 'active' ? 'active' : 'pending',
					nsPendingSince: now,
				})
				.where(eq(ManagedDomain.id, current.id))
				.returning()
			current = updated!
		}
		if (current.registrationStatus !== 'active') {
			await db
				.update(DomainJob)
				.set({ step: 'registering' })
				.where(eq(DomainJob.id, jobId))
			let registered = await adapters.registrar.getDomain(current.fqdn)
			if (!registered || registered.status !== 'active') {
				const contact = openContact(current.registrantContact)
				if (!contact) {
					await failRegistration(claimed, current, 'contact_missing', now)
					return 'failed' as const
				}
				const done = await adapters.registrar.register({
					fqdn: current.fqdn,
					years:
						(JSON.parse(claimed.params ?? '{}') as { years?: number }).years ??
						1,
					contact,
					privacy: current.privacy,
					autoRenew: current.autoRenew,
					nameservers: JSON.parse(current.nameservers ?? '[]') as string[],
					idempotencyKey: claimed.id,
				})
				registered = await adapters.registrar.getDomain(current.fqdn)
				void done
			}
			const [updated] = await db
				.update(ManagedDomain)
				.set({
					registrationStatus: 'active',
					registrarDomainId: registered?.fqdn ?? current.fqdn,
					expiresAt:
						registered?.expiresAt ?? new Date(now.getTime() + 365 * DAY),
					registrantEmailConfirmedAt: registered?.registrantEmailConfirmed
						? now
						: null,
					lastJobId: claimed.id,
				})
				.where(eq(ManagedDomain.id, current.id))
				.returning()
			current = updated!
		}

		await db
			.update(DomainJob)
			.set({ step: 'site' })
			.where(eq(DomainJob.id, jobId))
		const [org] = await db
			.select({ id: Organization.id, slug: Organization.slug })
			.from(Organization)
			.where(eq(Organization.id, current.organizationId))
			.limit(1)
		const existingHosts = await ensureSiteDomains(current.organizationId)
		if (
			org &&
			!existingHosts.some((row) => row.managedDomainId === current.id)
		) {
			await addSiteDomains({
				organization: org,
				hostname: current.fqdn,
				// The root works without CNAME trouble on a zone we host.
				primaryForm: 'apex',
				mode: primaryOf(existingHosts) ? 'redirect' : 'primary',
				actor: { userId: claimed.createdById },
				managedDomainId: current.id,
				method: 'registered',
			})
		}
		await syncSiteRecords(current.id)
		for (const row of await db
			.select()
			.from(SiteDomain)
			.where(eq(SiteDomain.managedDomainId, current.id))) {
			await checkAndNotify(row, { now }).catch(() => undefined)
		}
		await db
			.update(DomainJob)
			.set({ status: 'succeeded', step: 'done', completedAt: now })
			.where(eq(DomainJob.id, jobId))
		await notifyDomainEvent({
			organizationId: current.organizationId,
			kind: 'registered',
			entityId: claimed.id,
			host: current.fqdn,
			userIds: claimed.createdById ? [claimed.createdById] : undefined,
		})
		return 'succeeded' as const
	} catch (error) {
		const permanent =
			error instanceof RegistrarError &&
			['registry_error', 'domain_unavailable', 'tld_not_supported'].includes(
				error.code,
			)
		if (permanent || claimed.attempts >= MAX_JOB_ATTEMPTS) {
			await failRegistration(
				claimed,
				managed,
				error instanceof RegistrarError ? error.code : 'provider_error',
				now,
			)
			return 'failed' as const
		}
		await db
			.update(DomainJob)
			.set({
				status: 'queued',
				error: error instanceof RegistrarError ? error.code : 'provider_error',
				runAfter: new Date(
					now.getTime() + Math.min(60, 2 ** claimed.attempts) * 60_000,
				),
			})
			.where(eq(DomainJob.id, jobId))
		return 'retry' as const
	}
}

/** Jobs that are due, oldest first. */
export async function processDueDomainJobs(
	options: { now?: Date; limit?: number } = {},
) {
	const now = options.now ?? new Date()
	const due = await db
		.select({ id: DomainJob.id })
		.from(DomainJob)
		.where(
			and(
				eq(DomainJob.kind, 'register'),
				eq(DomainJob.status, 'queued'),
				sql`${DomainJob.step} <> 'charging'`,
				sql`${DomainJob.runAfter} <= ${now.getTime()}`,
			),
		)
		.orderBy(DomainJob.createdAt)
		.limit(options.limit ?? 20)
	const counts = { processed: 0, succeeded: 0, failed: 0, retried: 0 }
	for (const row of due) {
		const result = await processRegistrationJob(row.id, { now })
		if (result === 'skipped') continue
		counts.processed += 1
		if (result === 'succeeded') counts.succeeded += 1
		if (result === 'failed') counts.failed += 1
		if (result === 'retry') counts.retried += 1
	}
	return counts
}

/** What the progress screen shows for a job. */
export async function getDomainJobStatus(
	organizationId: string,
	jobId: string,
) {
	const [job] = await db
		.select()
		.from(DomainJob)
		.where(
			and(
				eq(DomainJob.id, jobId),
				eq(DomainJob.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!job) return null
	const params = JSON.parse(job.params ?? '{}') as { fqdn?: string }
	const [charge] = await db
		.select({
			status: DomainCharge.status,
			amountCents: DomainCharge.amountCents,
		})
		.from(DomainCharge)
		.where(eq(DomainCharge.jobId, job.id))
		.limit(1)
	return {
		id: job.id,
		kind: job.kind,
		status: job.status,
		step: job.step,
		error: job.error,
		fqdn: params.fqdn ?? null,
		refunded: charge?.status === 'refunded',
		chargeStatus: charge?.status ?? null,
		amountCents: charge?.amountCents ?? null,
	}
}

// ---------------------------------------------------------------------------
// Keeping the domain: auto-renew, renewals, reminders
// ---------------------------------------------------------------------------

async function loadOwnedRegistered(
	organizationId: string,
	id: string,
): Promise<ManagedRow> {
	const [row] = await db
		.select()
		.from(ManagedDomain)
		.where(
			and(
				eq(ManagedDomain.id, id),
				eq(ManagedDomain.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!row || row.source === 'nameservers')
		throw new RegistrarFlowError('not_found')
	return row
}

export async function setAutoRenew(input: {
	organizationId: string
	managedDomainId: string
	autoRenew: boolean
	actor: Actor
}) {
	const row = await loadOwnedRegistered(
		input.organizationId,
		input.managedDomainId,
	)
	await getDomainAdapters().registrar.setAutoRenew(row.fqdn, input.autoRenew)
	const [updated] = await db
		.update(ManagedDomain)
		.set({ autoRenew: input.autoRenew })
		.where(eq(ManagedDomain.id, row.id))
		.returning()
	await logRegistrar(
		input.organizationId,
		input.actor,
		`${input.autoRenew ? 'Turned on' : 'Turned off'} auto-renew for ${row.fqdn}.`,
		{ domain: row.fqdn, autoRenew: input.autoRenew },
	)
	return updated!
}

type Reminders = Partial<Record<'30' | '7', number>>

function remindersOf(row: ManagedRow): Reminders {
	try {
		return JSON.parse(row.reminders ?? '{}') as Reminders
	} catch {
		return {}
	}
}

const dateText = (date: Date) =>
	date.toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		timeZone: 'UTC',
	})

/**
 * Renewals and their notices, once per sweep:
 * reminders 30 and 7 days before the renewal date; the renewal charged
 * {RENEWAL_LEAD_DAYS} days before expiry; a declined card retried daily for 7
 * days, then urgent daily emails. Auto-renew off: no charge, no renewal.
 * Cancelling the Menuza subscription changes none of this.
 */
export async function processRenewals(
	options: { now?: Date; limit?: number } = {},
) {
	const now = options.now ?? new Date()
	const counts = { reminded: 0, renewed: 0, failed: 0, urgent: 0 }
	const rows = await db
		.select()
		.from(ManagedDomain)
		.where(
			and(
				inArray(ManagedDomain.source, ['registered', 'transferred']),
				eq(ManagedDomain.registrationStatus, 'active'),
				sql`${ManagedDomain.expiresAt} IS NOT NULL`,
			),
		)
		.limit(options.limit ?? 200)
	const registrar = getDomainAdapters().registrar
	for (const row of rows) {
		const expiresAt = row.expiresAt!
		const daysLeft = (expiresAt.getTime() - now.getTime()) / DAY
		const reminders = remindersOf(row)
		for (const days of [30, 7] as const) {
			if (
				daysLeft <= days &&
				daysLeft > 0 &&
				!reminders[String(days) as '30' | '7']
			) {
				reminders[String(days) as '30' | '7'] = now.getTime()
				// One sweep wins the reminder: the write only lands on the row we read.
				const claimed = await db
					.update(ManagedDomain)
					.set({ reminders: JSON.stringify(reminders) })
					.where(
						and(
							eq(ManagedDomain.id, row.id),
							sql`${ManagedDomain.reminders} IS ${row.reminders ?? null}`,
						),
					)
					.returning({ id: ManagedDomain.id })
				if (claimed.length === 0) continue
				await notifyDomainEvent({
					organizationId: row.organizationId,
					kind: 'renewal_reminder',
					entityId: `${row.id}:${expiresAt.getTime()}:${days}`,
					host: row.fqdn,
					detail: row.autoRenew
						? `It renews on ${dateText(expiresAt)} and the card on file is charged then. Turn off auto-renew on the Domain screen if you do not want to keep it.`
						: `Auto-renew is off, so it expires on ${dateText(expiresAt)}. Turn auto-renew on to keep it.`,
				})
				counts.reminded += 1
				break
			}
		}

		if (!row.autoRenew) {
			if (daysLeft <= 0) {
				await db
					.update(ManagedDomain)
					.set({ registrationStatus: 'expired' })
					.where(eq(ManagedDomain.id, row.id))
			}
			continue
		}
		if (daysLeft > RENEWAL_LEAD_DAYS) continue

		// Retry at most once a day.
		if (
			row.renewalAttemptedAt &&
			now.getTime() - row.renewalAttemptedAt.getTime() < DAY - 60_000
		) {
			continue
		}
		const failingFor = row.renewalFailedSince
			? now.getTime() - row.renewalFailedSince.getTime()
			: 0
		if (row.renewalFailedSince && failingFor > RENEWAL_RETRY_DAYS * DAY) {
			// Out of retries: the registrar's grace period; urgent emails each day.
			await notifyDomainEvent({
				organizationId: row.organizationId,
				kind: 'renewal_failed',
				entityId: `${row.id}:urgent:${now.toISOString().slice(0, 10)}`,
				host: row.fqdn,
				detail: `URGENT: we could not charge your card for 7 days, so ${row.fqdn} is in the registrar's grace period and will be lost soon. Update your card and renew now.`,
			})
			await db
				.update(ManagedDomain)
				.set({
					renewalAttemptedAt: now,
					registrationStatus:
						daysLeft <= 0 ? 'expired' : row.registrationStatus,
				})
				.where(eq(ManagedDomain.id, row.id))
			counts.urgent += 1
			continue
		}

		const [availability] = await registrar
			.checkAvailability([row.fqdn])
			.catch(() => [])
		// No price from the registrar: try again at the next sweep rather than guess.
		if (!availability || availability.renewalCostCents <= 0) continue
		const amountCents = retailCents(availability.renewalCostCents)
		const termKey = `${row.id}:${expiresAt.getTime()}`
		const [charge] = await db
			.insert(DomainCharge)
			.values({
				organizationId: row.organizationId,
				managedDomainId: row.id,
				kind: 'renewal',
				amountCents,
				idempotencyKey: `renew:${termKey}:${now.toISOString().slice(0, 10)}`,
			})
			.onConflictDoNothing()
			.returning()
		if (!charge) continue
		const paid = await getDomainPayments().charge({
			organizationId: row.organizationId,
			amountCents,
			currency: 'usd',
			idempotencyKey: charge.idempotencyKey,
			description: `Domain renewal: ${row.fqdn}`,
			metadata: {
				type: 'domain_renewal',
				organizationId: row.organizationId,
				domainId: row.id,
			},
		})
		if (paid.status === 'failed') {
			await db
				.update(DomainCharge)
				.set({ status: 'failed', failureCode: paid.code })
				.where(eq(DomainCharge.id, charge.id))
			await db
				.update(ManagedDomain)
				.set({
					renewalFailedSince: row.renewalFailedSince ?? now,
					renewalAttemptedAt: now,
				})
				.where(eq(ManagedDomain.id, row.id))
			if (!row.renewalFailedSince || failingFor > 3 * DAY) {
				await notifyDomainEvent({
					organizationId: row.organizationId,
					kind: 'renewal_failed',
					entityId: `${row.id}:${termKey}:${row.renewalFailedSince ? 'again' : 'first'}`,
					host: row.fqdn,
				})
			}
			counts.failed += 1
			continue
		}
		await db
			.update(DomainCharge)
			.set({ status: 'succeeded', stripePaymentIntentId: paid.paymentIntentId })
			.where(eq(DomainCharge.id, charge.id))
		try {
			const renewed = await registrar.renew(row.fqdn, 1, `renew-${termKey}`)
			await db
				.update(ManagedDomain)
				.set({
					expiresAt: renewed.expiresAt,
					reminders: null,
					renewalFailedSince: null,
					renewalAttemptedAt: now,
				})
				.where(eq(ManagedDomain.id, row.id))
			counts.renewed += 1
		} catch {
			// Paid but the registrar refused: give the money back and try tomorrow.
			await refundCharge(
				{
					...charge,
					stripePaymentIntentId: paid.paymentIntentId,
					status: 'succeeded',
				},
				now,
			)
			await db
				.update(ManagedDomain)
				.set({
					renewalFailedSince: row.renewalFailedSince ?? now,
					renewalAttemptedAt: now,
				})
				.where(eq(ManagedDomain.id, row.id))
			counts.failed += 1
		}
	}
	return counts
}

// ---------------------------------------------------------------------------
// Registrant email, transfers
// ---------------------------------------------------------------------------

export async function resendRegistrantVerification(input: {
	organizationId: string
	managedDomainId: string
}) {
	const row = await loadOwnedRegistered(
		input.organizationId,
		input.managedDomainId,
	)
	await getDomainAdapters().registrar.resendRegistrantVerification(row.fqdn)
}

/** The operator says they clicked the registry's link (when the registrar cannot tell us). */
export async function confirmRegistrantEmail(input: {
	organizationId: string
	managedDomainId: string
}) {
	const row = await loadOwnedRegistered(
		input.organizationId,
		input.managedDomainId,
	)
	const info = await getDomainAdapters()
		.registrar.getDomain(row.fqdn)
		.catch(() => null)
	// A registrar that reports "not confirmed" is believed over the operator.
	if (info?.registrantEmailConfirmed === false) return false
	await db
		.update(ManagedDomain)
		.set({ registrantEmailConfirmedAt: new Date() })
		.where(eq(ManagedDomain.id, row.id))
	return true
}

/** Transfer out: unlock the domain and show the authorization code. */
export async function transferOut(input: {
	organizationId: string
	managedDomainId: string
	now?: Date
	actor: Actor
}) {
	const now = input.now ?? new Date()
	const row = await loadOwnedRegistered(
		input.organizationId,
		input.managedDomainId,
	)
	if (row.registrationStatus !== 'active')
		throw new RegistrarFlowError('not_active')
	if (
		now.getTime() - row.createdAt.getTime() < TRANSFER_LOCK_DAYS * DAY &&
		row.source === 'registered'
	) {
		throw new RegistrarFlowError('too_new')
	}
	const registrar = getDomainAdapters().registrar
	await registrar.setLock(row.fqdn, false)
	const authCode = await registrar.getAuthCode(row.fqdn)
	await db
		.update(ManagedDomain)
		.set({ locked: false, autoRenew: false })
		.where(eq(ManagedDomain.id, row.id))
	await registrar.setAutoRenew(row.fqdn, false).catch(() => undefined)
	await logRegistrar(
		input.organizationId,
		input.actor,
		`Unlocked ${row.fqdn} for transfer out.`,
		{ domain: row.fqdn, change: 'transfer_out' },
	)
	return { authCode, fqdn: row.fqdn }
}

/** Locks the domain again (transfer cancelled). */
export async function lockDomain(input: {
	organizationId: string
	managedDomainId: string
}) {
	const row = await loadOwnedRegistered(
		input.organizationId,
		input.managedDomainId,
	)
	await getDomainAdapters().registrar.setLock(row.fqdn, true)
	await db
		.update(ManagedDomain)
		.set({ locked: true })
		.where(eq(ManagedDomain.id, row.id))
}

/**
 * Transfer in with the authorization code: charged like a one-year renewal,
 * refunded when the registrar refuses (locked, wrong code, registered less
 * than 60 days ago). The domain keeps its current DNS host until the operator
 * chooses "Let Menuza manage this domain".
 */
export async function startTransferIn(input: {
	organization: { id: string; slug: string; name: string }
	fqdn: string
	authCode: string
	contact: unknown
	acceptedPriceCents: number
	actor: Actor
}) {
	const registrar = await requireRegistrar(input.organization.id)
	const fqdn = assertBuyable(input.fqdn)
	const contact = parseRegistrantContact(input.contact)
	if (!contact.success) throw new RegistrarFlowError('invalid_contact')
	const authCode = input.authCode.trim()
	if (!authCode || authCode.length > 128)
		throw new RegistrarFlowError('invalid_auth_code')
	await assertNameFree(fqdn, input.organization.id)
	const [quote] = await registrar.checkAvailability([fqdn])
	const amountCents = retailCents(
		quote?.renewalCostCents || quote?.costCents || 1299,
	)
	if (amountCents !== input.acceptedPriceCents) {
		throw new RegistrarFlowError('price_changed', { priceCents: amountCents })
	}
	const payments = getDomainPayments()
	if (!(await payments.hasCardOnFile(input.organization.id))) {
		throw new RegistrarFlowError('no_card_on_file')
	}
	const [managed] = await db
		.insert(ManagedDomain)
		.values({
			organizationId: input.organization.id,
			fqdn,
			source: 'transferred',
			registrar: registrar.name,
			registrationStatus: 'transfer_pending',
			zoneStatus: 'none',
			registrantContact: sealContact(contact.data),
		})
		.returning()
	const [job] = await db
		.insert(DomainJob)
		.values({
			organizationId: input.organization.id,
			managedDomainId: managed!.id,
			kind: 'transfer_in',
			status: 'running',
			step: 'charging',
			idempotencyKey: `transfer_in:${managed!.id}`,
			params: JSON.stringify({ fqdn, priceCents: amountCents }),
			createdById: input.actor.userId,
		})
		.returning()
	const [charge] = await db
		.insert(DomainCharge)
		.values({
			organizationId: input.organization.id,
			managedDomainId: managed!.id,
			jobId: job!.id,
			kind: 'transfer_in',
			amountCents,
			idempotencyKey: `${job!.idempotencyKey}:charge`,
		})
		.returning()
	const paid = await payments.charge({
		organizationId: input.organization.id,
		amountCents,
		currency: 'usd',
		idempotencyKey: charge!.idempotencyKey,
		description: `Domain transfer: ${fqdn}`,
		metadata: {
			type: 'domain_transfer_in',
			organizationId: input.organization.id,
			jobId: job!.id,
		},
	})
	const abandon = async (code: string) => {
		await db
			.update(DomainJob)
			.set({
				status: 'failed',
				error: code,
				managedDomainId: null,
				completedAt: new Date(),
			})
			.where(eq(DomainJob.id, job!.id))
		await db.delete(ManagedDomain).where(eq(ManagedDomain.id, managed!.id))
	}
	if (paid.status === 'failed') {
		await db
			.update(DomainCharge)
			.set({ status: 'failed', failureCode: paid.code })
			.where(eq(DomainCharge.id, charge!.id))
		await abandon(paid.code)
		throw new RegistrarFlowError(paid.code)
	}
	await db
		.update(DomainCharge)
		.set({ status: 'succeeded', stripePaymentIntentId: paid.paymentIntentId })
		.where(eq(DomainCharge.id, charge!.id))
	try {
		const result = await registrar.transferIn({
			fqdn,
			authCode,
			contact: contact.data,
			privacy: true,
			autoRenew: true,
			idempotencyKey: job!.id,
		})
		await db
			.update(ManagedDomain)
			.set({
				registrarDomainId: result.registrarDomainId,
				registrationStatus:
					result.status === 'active' ? 'active' : 'transfer_pending',
				expiresAt:
					result.status === 'active' ? new Date(Date.now() + 365 * DAY) : null,
			})
			.where(eq(ManagedDomain.id, managed!.id))
		await db
			.update(DomainJob)
			.set({ status: 'succeeded', step: 'done', completedAt: new Date() })
			.where(eq(DomainJob.id, job!.id))
		await logRegistrar(
			input.organization.id,
			input.actor,
			`Started transferring ${fqdn} in.`,
			{ domain: fqdn, change: 'transfer_in' },
		)
		return {
			jobId: job!.id,
			managedDomainId: managed!.id,
			status: result.status,
		}
	} catch (error) {
		const code =
			error instanceof RegistrarError &&
			['locked', 'invalid_auth_code', 'too_new', 'transfer_failed'].includes(
				error.code,
			)
				? (error.code as
						'locked' | 'invalid_auth_code' | 'too_new' | 'transfer_failed')
				: 'transfer_failed'
		const [fresh] = await db
			.select()
			.from(DomainCharge)
			.where(eq(DomainCharge.id, charge!.id))
			.limit(1)
		if (fresh) await refundCharge(fresh, new Date())
		await abandon(code)
		throw new RegistrarFlowError(code)
	}
}

export async function listOwnedDomains(organizationId: string) {
	return db
		.select()
		.from(ManagedDomain)
		.where(
			and(
				eq(ManagedDomain.organizationId, organizationId),
				inArray(ManagedDomain.source, ['registered', 'transferred']),
			),
		)
}
