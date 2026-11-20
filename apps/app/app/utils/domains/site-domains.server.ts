import { AuditAction } from '@repo/audit'
import {
	buildHostChecklist,
	checklistComplete,
	evaluateChecklist,
	type ChecklistRecord,
	type RecordResult,
	type VerificationRecord,
} from '@repo/common/domain-dns'
import {
	describeHostname,
	DOMAIN_PENDING_EXPIRY_MS,
	DOMAIN_PENDING_REMINDER_MS,
	hostsForConnect,
	isDomainLive,
	isReservedHostname,
	MAX_SITE_DOMAINS,
	parseHostname,
	type DomainErrorCode,
	type PrimaryForm,
} from '@repo/common/domains'
import {
	and,
	db,
	eq,
	inArray,
	Organization,
	SiteDomain,
	sql,
} from '@repo/database'
import {
	createCustomHostname,
	deleteCustomHostname,
	getCustomHostname,
	retryCustomHostnameValidation,
	type CloudflareCustomHostname,
} from '#app/utils/sites/cloudflare-custom-hostnames.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { findHostOwner } from '#app/utils/sites/site-host.server.ts'
import { logWebsiteActivity } from '#app/utils/website/activity.server.ts'
import {
	platformDomains,
	siteApexIps,
	siteCnameTarget,
} from './config.server.ts'
import {
	fetchHostAnswers,
	getDnsResolver,
	type DnsResolver,
} from './dns-resolver.server.ts'
import { notifyDomainEvent } from './notify.server.ts'

/**
 * Connecting, checking and switching the hosts a restaurant's site is served
 * on (#139). One `SiteDomain` row per host; `Organization.customDomain` mirrors
 * the primary for one release so every older reader keeps working.
 */

export type SiteDomainRow = typeof SiteDomain.$inferSelect

export type DomainFailure =
	| DomainErrorCode
	| 'not_found'
	| 'primary_in_use'
	| 'primary_exists'
	| 'no_primary'
	| 'already_connected'
	| 'cloudflare_failed'

export class DomainError extends Error {
	constructor(
		readonly code: DomainFailure,
		message?: string,
		readonly host?: string,
	) {
		super(message ?? code)
		this.name = 'DomainError'
	}
}

type VerificationData = {
	ownership: VerificationRecord | null
	ssl: VerificationRecord[]
}

type StoredChecks = { at: string; results: RecordResult[] }

function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback
	try {
		return JSON.parse(value) as T
	} catch {
		return fallback
	}
}

export function verificationFrom(
	hostname: CloudflareCustomHostname | null,
	previous?: string | null,
): VerificationData {
	if (!hostname)
		return parseJson<VerificationData>(previous, { ownership: null, ssl: [] })
	return {
		ownership: hostname.ownershipVerification ?? null,
		ssl: hostname.sslValidationRecords ?? [],
	}
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The organization's hosts, primary first. A primary that exists only as
 * `Organization.customDomain` (before the migration's copy reached it) gets its
 * row here, so every caller sees one model.
 */
export async function ensureSiteDomains(
	organizationId: string,
): Promise<SiteDomainRow[]> {
	let rows = await db
		.select()
		.from(SiteDomain)
		.where(eq(SiteDomain.organizationId, organizationId))
	const [organization] = await db
		.select({
			customDomain: Organization.customDomain,
			customDomainStatus: Organization.customDomainStatus,
			cloudflareHostnameId: Organization.cloudflareHostnameId,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	const legacy = organization?.customDomain?.trim().toLowerCase()
	if (legacy && !rows.some((row) => row.hostname === legacy)) {
		const status = organization?.customDomainStatus ?? 'pending'
		const hasPrimary = rows.some((row) => row.isPrimary)
		const inserted = await db
			.insert(SiteDomain)
			.values({
				organizationId,
				hostname: legacy,
				isPrimary: !hasPrimary,
				method: 'cname',
				cloudflareHostnameId: organization?.cloudflareHostnameId ?? null,
				status: [
					'active',
					'pending',
					'moved',
					'blocked',
					'error',
					'expired',
				].includes(status)
					? status
					: 'error',
				pendingSince: status === 'active' ? null : new Date(),
			})
			.onConflictDoNothing()
			.returning()
		rows = [...rows, ...inserted]
	}
	return rows.sort(
		(a, b) =>
			Number(b.isPrimary) - Number(a.isPrimary) ||
			a.hostname.localeCompare(b.hostname),
	)
}

export function primaryOf(rows: SiteDomainRow[]) {
	return rows.find((row) => row.isPrimary) ?? null
}

export type SiteDomainView = {
	id: string
	hostname: string
	isPrimary: boolean
	role: 'apex' | 'www' | 'subdomain'
	method: string
	status: string
	sslStatus: string | null
	ownershipStatus: string | null
	live: boolean
	records: ChecklistRecord[]
	results: RecordResult[]
	lastCheckedAt: string | null
	pendingSince: string | null
	/** Days left before a host pending this long is released (30 days). */
	expiresInDays: number | null
	lastError: string | null
	managedDomainId: string | null
}

function checklistInput(row: SiteDomainRow) {
	const parts = describeHostname(row.hostname)
	const verification = parseJson<VerificationData>(row.verification, {
		ownership: null,
		ssl: [],
	})
	return {
		hostname: row.hostname,
		role: parts?.role ?? ('subdomain' as const),
		cnameTarget: siteCnameTarget(),
		apexIps: siteApexIps(),
		ownership: verification.ownership,
		sslValidation: verification.ssl,
	}
}

/** What the screen shows for one host: its records and the last DNS result. */
export function toSiteDomainView(
	row: SiteDomainRow,
	now = new Date(),
): SiteDomainView {
	const input = checklistInput(row)
	const checks = parseJson<StoredChecks>(row.checks, { at: '', results: [] })
	const pendingFor = row.pendingSince
		? now.getTime() - row.pendingSince.getTime()
		: null
	return {
		id: row.id,
		hostname: row.hostname,
		isPrimary: row.isPrimary,
		role: input.role,
		method: row.method,
		status: row.status,
		sslStatus: row.sslStatus,
		ownershipStatus: row.ownershipStatus,
		live: isDomainLive(row),
		records: buildHostChecklist(input),
		results: checks.results,
		lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
		pendingSince: row.pendingSince?.toISOString() ?? null,
		expiresInDays:
			row.status === 'pending' && pendingFor !== null
				? Math.max(
						0,
						Math.ceil((DOMAIN_PENDING_EXPIRY_MS - pendingFor) / 86_400_000),
					)
				: null,
		lastError: row.lastError,
		managedDomainId: row.managedDomainId,
	}
}

// ---------------------------------------------------------------------------
// Rules before anything is created
// ---------------------------------------------------------------------------

export function assertHostAllowed(hostname: string) {
	if (isReservedHostname(hostname, platformDomains())) {
		throw new DomainError(
			'hostname_reserved' as DomainFailure,
			undefined,
			hostname,
		)
	}
}

export async function assertHostFree(hostname: string, organizationId: string) {
	const owner = await findHostOwner(hostname)
	if (owner && owner.organizationId !== organizationId) {
		throw new DomainError('hostname_taken', undefined, hostname)
	}
}

/** Mirrors the primary host onto the organization (the denormalized copy). */
export async function syncOrganizationPrimary(organizationId: string) {
	const [primary] = await db
		.select()
		.from(SiteDomain)
		.where(
			and(
				eq(SiteDomain.organizationId, organizationId),
				eq(SiteDomain.isPrimary, true),
			),
		)
		.limit(1)
	// An expired primary no longer holds the name (the column is unique), so the
	// copy is cleared; the SiteDomain row stays for the operator to retry.
	const holding = primary && primary.status !== 'expired' ? primary : null
	await db
		.update(Organization)
		.set({
			customDomain: holding?.hostname ?? null,
			customDomainStatus: holding?.status ?? null,
			cloudflareHostnameId: holding?.cloudflareHostnameId ?? null,
		})
		.where(eq(Organization.id, organizationId))
}

async function purgeAllHosts(organization: { id: string; slug: string }) {
	await purgeOrganizationSiteCache(organization.id, organization.slug)
}

type Actor = { userId: string | null; request?: Request }

async function logDomain(
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
// Connecting
// ---------------------------------------------------------------------------

export type AddDomainInput = {
	organization: { id: string; slug: string }
	/** What the operator typed. */
	hostname: string
	primaryForm: PrimaryForm
	/** `primary` connects the site; `redirect` adds hosts that redirect to it. */
	mode: 'primary' | 'redirect'
	actor: Actor
	managedDomainId?: string | null
	method?: 'cname' | 'nameservers' | 'registered'
}

/**
 * Connects a domain: both forms of it (`example.com` and `www.example.com`)
 * with the chosen one primary, or one other subdomain. Extra domains are
 * added with `mode: 'redirect'` and every host of them redirects to the
 * primary. Hosts already connected to another organization or that belong to
 * the platform are refused before anything is created.
 */
export async function addSiteDomains(
	input: AddDomainInput,
): Promise<SiteDomainRow[]> {
	const parsed = parseHostname(input.hostname)
	if (!parsed.ok) throw new DomainError('hostname_invalid', parsed.error)
	const plan = hostsForConnect(parsed.hostname, input.primaryForm)
	if (!plan) throw new DomainError('hostname_invalid')

	let existing = await ensureSiteDomains(input.organization.id)
	// An expired primary was released: it does not stand in the way of a new one.
	const expiredPrimary = existing.find((row) => row.isPrimary && row.status === 'expired')
	if (input.mode === 'primary' && expiredPrimary) {
		await db.delete(SiteDomain).where(eq(SiteDomain.id, expiredPrimary.id))
		existing = existing.filter((row) => row.id !== expiredPrimary.id)
	}
	const currentPrimary = primaryOf(existing)
	if (input.mode === 'primary' && currentPrimary) {
		throw new DomainError('primary_exists')
	}
	if (input.mode === 'redirect' && !currentPrimary) {
		throw new DomainError('no_primary')
	}

	const wanted = [
		...(input.mode === 'primary' ? [plan.primary] : []),
		...(input.mode === 'primary'
			? plan.redirects
			: [plan.primary, ...plan.redirects]),
	]
	const fresh = wanted.filter(
		(host) => !existing.some((row) => row.hostname === host),
	)
	if (fresh.length === 0)
		throw new DomainError('already_connected', undefined, wanted[0])
	for (const host of fresh) {
		assertHostAllowed(host)
		await assertHostFree(host, input.organization.id)
	}
	if (existing.length + fresh.length > MAX_SITE_DOMAINS) {
		throw new DomainError('domain_limit')
	}

	const created: SiteDomainRow[] = []
	try {
		for (const host of fresh) {
			// An expired row of another organization keeps the name reserved in the table.
			await db
				.delete(SiteDomain)
				.where(
					and(eq(SiteDomain.hostname, host), eq(SiteDomain.status, 'expired')),
				)
			const hostname = await createCustomHostname(host)
			const isPrimary = input.mode === 'primary' && host === plan.primary
			const [row] = await db
				.insert(SiteDomain)
				.values({
					organizationId: input.organization.id,
					hostname: host,
					isPrimary,
					managedDomainId: input.managedDomainId ?? null,
					method: input.method ?? 'cname',
					cloudflareHostnameId: hostname.id,
					status: hostname.status,
					sslStatus: hostname.sslStatus ?? null,
					ownershipStatus: hostname.ownershipStatus ?? null,
					verification: JSON.stringify(verificationFrom(hostname)),
					pendingSince: hostname.status === 'active' ? null : new Date(),
					addedById: input.actor.userId,
				})
				.returning()
			created.push(row!)
		}
	} catch (error) {
		// All or nothing: a half-connected pair would serve one form only.
		for (const row of created) {
			if (row.cloudflareHostnameId) {
				await deleteCustomHostname(row.cloudflareHostnameId).catch(
					() => undefined,
				)
			}
			await db.delete(SiteDomain).where(eq(SiteDomain.id, row.id))
		}
		if (error instanceof DomainError) throw error
		throw new DomainError(
			'cloudflare_failed',
			error instanceof Error ? error.message : 'Failed to connect the domain.',
		)
	}

	if (input.mode === 'primary') {
		await syncOrganizationPrimary(input.organization.id)
		await db
			.update(Organization)
			.set({ sitePublished: true })
			.where(eq(Organization.id, input.organization.id))
	}
	await logDomain(
		input.organization.id,
		input.actor,
		input.mode === 'primary'
			? `Connected the custom domain ${plan.primary}.`
			: `Added ${fresh.join(', ')} as redirecting domains.`,
		{
			hosts: fresh,
			primary:
				input.mode === 'primary' ? plan.primary : currentPrimary?.hostname,
		},
	)
	await purgeAllHosts(input.organization)
	return created
}

/** Makes `hostname` the primary; the old primary stays and redirects to it. */
export async function setPrimaryDomain(input: {
	organization: { id: string; slug: string }
	hostname: string
	actor: Actor
}) {
	const rows = await ensureSiteDomains(input.organization.id)
	const next = rows.find((row) => row.hostname === input.hostname.toLowerCase())
	if (!next || next.status === 'expired') throw new DomainError('not_found')
	const old = primaryOf(rows)
	if (old?.id === next.id) return next
	// One batch: demote first so the one-primary index never sees two.
	await db.batch([
		...(old
			? [
					db
						.update(SiteDomain)
						.set({ isPrimary: false })
						.where(eq(SiteDomain.id, old.id)),
				]
			: []),
		db
			.update(SiteDomain)
			.set({ isPrimary: true })
			.where(eq(SiteDomain.id, next.id)),
		db
			.update(Organization)
			.set({
				customDomain: next.hostname,
				customDomainStatus: next.status,
				cloudflareHostnameId: next.cloudflareHostnameId,
			})
			.where(eq(Organization.id, input.organization.id)),
	] as never)
	await logDomain(
		input.organization.id,
		input.actor,
		`Made ${next.hostname} the primary domain. ${old ? `${old.hostname} now redirects to it.` : ''}`.trim(),
		{ from: old?.hostname ?? null, to: next.hostname },
	)
	await purgeAllHosts(input.organization)
	return { ...next, isPrimary: true }
}

/** Removes one host and frees it at once. The primary stays while others remain. */
export async function removeSiteDomain(input: {
	organization: { id: string; slug: string }
	hostname: string
	actor: Actor
}) {
	const rows = await ensureSiteDomains(input.organization.id)
	const row = rows.find(
		(entry) => entry.hostname === input.hostname.toLowerCase(),
	)
	if (!row) throw new DomainError('not_found')
	if (row.isPrimary && rows.length > 1) throw new DomainError('primary_in_use')
	await releaseRow(row)
	if (row.isPrimary) await syncOrganizationPrimary(input.organization.id)
	await logDomain(
		input.organization.id,
		input.actor,
		`Disconnected the custom domain ${row.hostname}.`,
		{ from: row.hostname, to: null },
	)
	await purgeAllHosts(input.organization)
}

/** Disconnects every host of the organization. */
export async function disconnectAllDomains(input: {
	organization: { id: string; slug: string }
	actor: Actor
}) {
	const rows = await ensureSiteDomains(input.organization.id)
	for (const row of rows) await releaseRow(row)
	await syncOrganizationPrimary(input.organization.id)
	if (rows.length > 0) {
		await logDomain(
			input.organization.id,
			input.actor,
			`Disconnected the custom domain ${rows.map((row) => row.hostname).join(', ')}.`,
			{ from: rows.find((row) => row.isPrimary)?.hostname ?? null, to: null },
		)
	}
	await purgeAllHosts(input.organization)
}

async function releaseRow(row: SiteDomainRow) {
	if (row.cloudflareHostnameId) {
		await deleteCustomHostname(row.cloudflareHostnameId)
	}
	await db.delete(SiteDomain).where(eq(SiteDomain.id, row.id))
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export type CheckResult = {
	row: SiteDomainRow
	view: SiteDomainView
	becameLive: boolean
	complete: boolean
}

/**
 * Reads Cloudflare's status for a host and looks its DNS up: which records are
 * found, which are missing, ownership apart from the certificate (#139). Saves
 * the result. `retryCertificate` asks Cloudflare to try validation again.
 */
export async function checkSiteDomain(
	row: SiteDomainRow,
	options: {
		resolver?: DnsResolver
		now?: Date
		retryCertificate?: boolean
	} = {},
): Promise<CheckResult> {
	const now = options.now ?? new Date()
	const resolver = options.resolver ?? getDnsResolver()
	const hostname = row.cloudflareHostnameId
		? options.retryCertificate
			? await retryCustomHostnameValidation(row.cloudflareHostnameId).catch(
					() => getCustomHostname(row.cloudflareHostnameId!),
				)
			: await getCustomHostname(row.cloudflareHostnameId)
		: null

	const verification = verificationFrom(hostname, row.verification)
	const input = {
		...checklistInput(row),
		ownership: verification.ownership,
		sslValidation: verification.ssl,
	}
	const records = buildHostChecklist(input)
	const answers = await fetchHostAnswers({
		resolver,
		hostname: row.hostname,
		cnameTarget: input.cnameTarget,
		extraNames: records
			.filter((record) => record.kind !== 'route')
			.map((r) => r.name),
	})
	const results = evaluateChecklist(records, input, answers)

	const status = hostname?.status ?? row.status
	const wasLive = isDomainLive(row)
	const next = {
		status,
		sslStatus: hostname?.sslStatus ?? row.sslStatus,
		ownershipStatus: hostname?.ownershipStatus ?? row.ownershipStatus,
		verification: JSON.stringify(verification),
		checks: JSON.stringify({
			at: now.toISOString(),
			results,
		} satisfies StoredChecks),
		lastCheckedAt: now,
		lastError: hostname?.verificationErrors?.[0] ?? null,
		// The pending clock runs while the host waits and stops when it is live.
		pendingSince: status === 'active' ? null : (row.pendingSince ?? now),
	}
	const [updated] = await db
		.update(SiteDomain)
		.set(next)
		.where(eq(SiteDomain.id, row.id))
		.returning()
	const saved = updated ?? { ...row, ...next }
	if (saved.isPrimary) await syncOrganizationPrimary(saved.organizationId)
	const nowLive = isDomainLive(saved)
	return {
		row: saved,
		view: toSiteDomainView(saved, now),
		becameLive: nowLive && !wasLive,
		complete: checklistComplete(records, results),
	}
}

/** The check plus the "your domain is live" notice, sent once for the primary. */
export async function checkAndNotify(
	row: SiteDomainRow,
	options: Parameters<typeof checkSiteDomain>[1] = {},
): Promise<CheckResult> {
	const result = await checkSiteDomain(row, options)
	if (
		result.row.isPrimary &&
		isDomainLive(result.row) &&
		!result.row.liveNotifiedAt
	) {
		const claimed = await db
			.update(SiteDomain)
			.set({ liveNotifiedAt: options.now ?? new Date() })
			.where(
				and(
					eq(SiteDomain.id, row.id),
					sql`${SiteDomain.liveNotifiedAt} IS NULL`,
				),
			)
			.returning({ id: SiteDomain.id })
		if (claimed.length > 0) {
			await notifyDomainEvent({
				organizationId: row.organizationId,
				kind: 'live',
				entityId: row.id,
				host: row.hostname,
				userIds: row.addedById ? [row.addedById] : undefined,
			})
			const [org] = await db
				.select({ slug: Organization.slug })
				.from(Organization)
				.where(eq(Organization.id, row.organizationId))
				.limit(1)
			if (org) await purgeAllHosts({ id: row.organizationId, slug: org.slug })
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// The 15-minute sweep (#139)
// ---------------------------------------------------------------------------

export type SweepCounts = {
	checked: number
	live: number
	reminded: number
	expired: number
	errors: number
}

function missingRecordsText(row: SiteDomainRow): string {
	const view = toSiteDomainView(row)
	const missing = view.records
		.filter((record) => record.kind === 'route')
		.filter(
			(record) =>
				view.results.find((r) => r.id === record.id)?.check !== 'found',
		)
	if (missing.length === 0) return ''
	return `Still missing: ${missing
		.map(
			(record) =>
				`${record.type === 'ALIAS' ? 'ALIAS or A' : record.type} ${record.name} -> ${record.value}`,
		)
		.join('; ')}.`
}

/**
 * Checks every pending host: a host that came up becomes live and its
 * operator is told; a host pending for 7 days gets one "still not connected"
 * email with the missing records; after 30 days it is released at Cloudflare
 * and marked expired. Bounded per run; the rest is picked up next time.
 */
export async function sweepSiteDomains(
	options: { now?: Date; resolver?: DnsResolver; limit?: number } = {},
): Promise<SweepCounts> {
	const now = options.now ?? new Date()
	const counts: SweepCounts = {
		checked: 0,
		live: 0,
		reminded: 0,
		expired: 0,
		errors: 0,
	}
	const rows = await db
		.select()
		.from(SiteDomain)
		.where(eq(SiteDomain.status, 'pending'))
		.orderBy(sql`coalesce(${SiteDomain.lastCheckedAt}, 0)`)
		.limit(options.limit ?? 100)

	const orgIds = [...new Set(rows.map((row) => row.organizationId))]
	const primaries = orgIds.length
		? await db
				.select()
				.from(SiteDomain)
				.where(
					and(
						eq(SiteDomain.isPrimary, true),
						inArray(SiteDomain.organizationId, orgIds.slice(0, 90)),
					),
				)
		: []

	for (const row of rows) {
		try {
			const result = await checkAndNotify(row, {
				now,
				resolver: options.resolver,
			})
			counts.checked += 1
			if (result.becameLive) {
				counts.live += 1
				continue
			}
			if (result.row.status !== 'pending') continue
			const pendingMs =
				now.getTime() - (result.row.pendingSince ?? now).getTime()
			if (pendingMs >= DOMAIN_PENDING_EXPIRY_MS) {
				await expireSiteDomain(result.row)
				counts.expired += 1
				continue
			}
			const primary = primaries.find(
				(p) => p.organizationId === row.organizationId,
			)
			const worthReminding = row.isPrimary || primary?.status === 'active'
			if (
				pendingMs >= DOMAIN_PENDING_REMINDER_MS &&
				!result.row.reminderSentAt &&
				worthReminding
			) {
				const claimed = await db
					.update(SiteDomain)
					.set({ reminderSentAt: now })
					.where(
						and(
							eq(SiteDomain.id, row.id),
							sql`${SiteDomain.reminderSentAt} IS NULL`,
						),
					)
					.returning({ id: SiteDomain.id })
				if (claimed.length > 0) {
					await notifyDomainEvent({
						organizationId: row.organizationId,
						kind: 'pending_reminder',
						entityId: row.id,
						host: row.hostname,
						userIds: row.addedById ? [row.addedById] : undefined,
						detail:
							`It has been a week since you started. ${missingRecordsText(result.row)}`.trim(),
					})
					counts.reminded += 1
				}
			}
		} catch (error) {
			counts.errors += 1
			console.error(
				'Domain status check failed:',
				row.id,
				error instanceof Error ? error.message : error,
			)
		}
	}
	return counts
}

/** After 30 days pending: free the Cloudflare hostname and mark it expired. */
export async function expireSiteDomain(row: SiteDomainRow) {
	if (row.cloudflareHostnameId) {
		await deleteCustomHostname(row.cloudflareHostnameId).catch((error) => {
			console.error(
				'Releasing the hostname failed:',
				error instanceof Error ? error.message : error,
			)
		})
	}
	await db
		.update(SiteDomain)
		.set({ status: 'expired', cloudflareHostnameId: null, pendingSince: null })
		.where(eq(SiteDomain.id, row.id))
	if (row.isPrimary) await syncOrganizationPrimary(row.organizationId)
	const [org] = await db
		.select({ slug: Organization.slug })
		.from(Organization)
		.where(eq(Organization.id, row.organizationId))
		.limit(1)
	if (org) await purgeAllHosts({ id: row.organizationId, slug: org.slug })
	await notifyDomainEvent({
		organizationId: row.organizationId,
		kind: 'expired',
		entityId: row.id,
		host: row.hostname,
		userIds: row.addedById ? [row.addedById] : undefined,
	})
}

/** An expired host the operator wants again: connect it the same way as new. */
export async function retryExpiredDomain(input: {
	organization: { id: string; slug: string }
	hostname: string
	actor: Actor
}) {
	const rows = await ensureSiteDomains(input.organization.id)
	const row = rows.find(
		(entry) => entry.hostname === input.hostname.toLowerCase(),
	)
	if (!row || row.status !== 'expired') throw new DomainError('not_found')
	await assertHostFree(row.hostname, input.organization.id)
	const hostname = await createCustomHostname(row.hostname)
	const [updated] = await db
		.update(SiteDomain)
		.set({
			cloudflareHostnameId: hostname.id,
			status: hostname.status,
			sslStatus: hostname.sslStatus ?? null,
			ownershipStatus: hostname.ownershipStatus ?? null,
			verification: JSON.stringify(verificationFrom(hostname)),
			pendingSince: hostname.status === 'active' ? null : new Date(),
			reminderSentAt: null,
			liveNotifiedAt: null,
		})
		.where(eq(SiteDomain.id, row.id))
		.returning()
	if (row.isPrimary) await syncOrganizationPrimary(input.organization.id)
	await purgeAllHosts(input.organization)
	return updated!
}
