import { AuditAction } from '@repo/audit'
import {
	analyzeMail,
	COMMON_DKIM_SELECTORS,
	type MailFindings,
} from '@repo/common/domain-dns'
import {
	changeTouchesMail,
	emailConfirmationMatches,
	evaluateEmailSafety,
	exportZoneFile,
	isMailRecord,
	isSpf,
	mergeSpf,
	parseZoneFile,
	planSiteRecords,
	spfMechanisms,
	validateRecord,
	validateRecordRemoval,
	type EmailSafety,
	type RecordIssue,
	type ZoneFileResult,
	type ZoneRecord,
} from '@repo/common/domain-zone'
import {
	describeHostname,
	hostsForConnect,
	trimDnsName,
	type PrimaryForm,
} from '@repo/common/domains'
import {
	and,
	db,
	DomainRecord,
	eq,
	inArray,
	ManagedDomain,
	SiteDomain,
} from '@repo/database'
import { logWebsiteActivity } from '#app/utils/website/activity.server.ts'
import { getDomainAdapters } from './adapters.select.server.ts'
import { siteApexIps, siteCnameTarget } from './config.server.ts'
import {
	getDnsResolver,
	lookupMany,
	lookupMx,
	lookupNameservers,
	lookupTxt,
	type DnsResolver,
} from './dns-resolver.server.ts'
import {
	addSiteDomains,
	assertHostAllowed,
	checkAndNotify,
	DomainError,
	ensureSiteDomains,
	primaryOf,
	type SiteDomainRow,
} from './site-domains.server.ts'

/**
 * Letting Menuza manage a domain's DNS (#283): the scan before anything moves,
 * the email guard, the nameserver move, and the records list afterwards. One
 * zone model (`ManagedDomain` + `DomainRecord`) is what buying (#183) and email
 * forwarding (#276) use too.
 */

export type ManagedDomainRow = typeof ManagedDomain.$inferSelect
export type DomainRecordRow = typeof DomainRecord.$inferSelect

export type ZoneFailure =
	| 'subdomain_not_allowed'
	| 'email_confirmation_required'
	| 'zone_exists'
	| 'zone_failed'
	| 'domain_not_found'
	| 'invalid_record'
	| 'managed_readonly'
	| 'forwarding_active'
	| 'registered_here'
	| 'zone_file_invalid'

export class ZoneError extends Error {
	constructor(
		readonly code: ZoneFailure,
		readonly issues: RecordIssue[] = [],
	) {
		super(code)
		this.name = 'ZoneError'
	}
}

type Actor = { userId: string | null; request?: Request }

export function toZoneRecord(row: DomainRecordRow): ZoneRecord {
	return {
		id: row.id,
		type: row.type as ZoneRecord['type'],
		name: row.name,
		content: row.content,
		ttl: row.ttl,
		priority: row.priority,
		proxied: row.proxied,
		managedBy: (row.managedBy as ZoneRecord['managedBy']) ?? null,
	}
}

async function logZone(
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
// The scan
// ---------------------------------------------------------------------------

export type ZoneScan = {
	scannedAt: string
	domain: string
	records: ZoneRecord[]
	mail: Pick<MailFindings, 'kind' | 'provider'>
	emailSafety: EmailSafety
	zoneFile: {
		used: boolean
		errors: ZoneFileResult['errors']
		recordCount: number
	}
}

const SERVICE_NAMES = [
	'mail',
	'webmail',
	'autodiscover',
	'autoconfig',
	'smtp',
	'imap',
]

function dedupe(records: ZoneRecord[]): ZoneRecord[] {
	const seen = new Set<string>()
	return records.filter((record) => {
		const key = `${record.type}|${trimDnsName(record.name)}|${record.content.trim().toLowerCase()}|${record.priority ?? ''}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

/**
 * Reads what the domain's DNS says today (website, MX, SPF, DKIM, DMARC and the
 * usual service names), and the zone file the operator uploaded, if any. A DNS
 * scan cannot list a zone, so only an uploaded zone file makes a move with
 * email on the domain "safe"; without one the move needs a typed confirmation.
 */
export async function scanDomain(input: {
	domain: string
	zoneFile?: string | null
	resolver?: DnsResolver
}): Promise<ZoneScan> {
	const resolver = input.resolver ?? getDnsResolver()
	const domain = trimDnsName(input.domain)
	const www = `www.${domain}`
	const rows: ZoneRecord[] = []
	const add = (
		type: ZoneRecord['type'],
		name: string,
		content: string,
		priority?: number,
	) =>
		rows.push({
			type,
			name,
			content,
			...(priority !== undefined ? { priority } : {}),
		})

	const [apex, wwwAnswers, mx, apexTxt, dmarc, dkim, services] =
		await Promise.all([
			lookupMany(resolver, domain, ['A', 'AAAA', 'CNAME']),
			lookupMany(resolver, www, ['A', 'AAAA', 'CNAME']),
			lookupMx(resolver, domain),
			lookupTxt(resolver, domain),
			lookupTxt(resolver, `_dmarc.${domain}`),
			Promise.all(
				COMMON_DKIM_SELECTORS.map(async (selector) => {
					const name = `${selector}._domainkey.${domain}`
					const [txt, cname] = await Promise.all([
						lookupTxt(resolver, name),
						resolver(name, 'CNAME'),
					])
					return {
						selector: selector as string,
						txt,
						cname: cname.map((a) => trimDnsName(a.data)),
					}
				}),
			),
			Promise.all(
				SERVICE_NAMES.map(async (label) => {
					const name = `${label}.${domain}`
					return {
						name,
						answers: await lookupMany(resolver, name, ['A', 'AAAA', 'CNAME']),
					}
				}),
			),
		])
	for (const a of apex.A) add('A', domain, a.data)
	for (const a of apex.AAAA) add('AAAA', domain, a.data)
	for (const a of apex.CNAME) add('CNAME', domain, trimDnsName(a.data))
	for (const a of wwwAnswers.A) add('A', www, a.data)
	for (const a of wwwAnswers.AAAA) add('AAAA', www, a.data)
	for (const a of wwwAnswers.CNAME) add('CNAME', www, trimDnsName(a.data))
	for (const record of mx) add('MX', domain, record.host, record.priority)
	for (const value of apexTxt) add('TXT', domain, value)
	for (const value of dmarc) add('TXT', `_dmarc.${domain}`, value)
	for (const entry of dkim) {
		const name = `${entry.selector}._domainkey.${domain}`
		for (const value of entry.txt) add('TXT', name, value)
		for (const value of entry.cname) add('CNAME', name, value)
	}
	for (const service of services) {
		for (const a of service.answers.A) add('A', service.name, a.data)
		for (const a of service.answers.AAAA) add('AAAA', service.name, a.data)
		for (const a of service.answers.CNAME)
			add('CNAME', service.name, trimDnsName(a.data))
	}
	const scanned = dedupe(rows)

	let uploaded: ZoneRecord[] | null = null
	let fileResult: ZoneFileResult = { records: [], errors: [] }
	if (input.zoneFile?.trim()) {
		fileResult = parseZoneFile(input.zoneFile, domain)
		uploaded = fileResult.records
	}
	const mail = analyzeMail(
		{
			mx,
			apexTxt,
			dmarcTxt: dmarc,
			dkim: dkim.map((entry) => ({
				selector: entry.selector,
				values: [...entry.txt, ...entry.cname],
			})),
		},
		domain,
	)
	// The uploaded file can show mail the DNS probes missed.
	const mailKind =
		mail.kind !== 'none' || !uploaded
			? mail.kind
			: uploaded.some((record) => isMailRecord(record, domain))
				? 'mail'
				: 'none'
	const records = dedupe([...(uploaded ?? []), ...scanned])
	return {
		scannedAt: new Date().toISOString(),
		domain,
		records,
		mail: { kind: mailKind, provider: mail.provider },
		emailSafety: evaluateEmailSafety({ domain, mailKind, scanned, uploaded }),
		zoneFile: {
			used: Boolean(uploaded),
			errors: fileResult.errors,
			recordCount: fileResult.records.length,
		},
	}
}

// ---------------------------------------------------------------------------
// Moving a domain to our nameservers
// ---------------------------------------------------------------------------

function isSiteHostRecord(record: ZoneRecord, hosts: string[]) {
	return (
		hosts.includes(trimDnsName(record.name)) &&
		(record.type === 'A' || record.type === 'AAAA' || record.type === 'CNAME')
	)
}

export async function findManagedDomain(organizationId: string, fqdn: string) {
	const [row] = await db
		.select()
		.from(ManagedDomain)
		.where(
			and(
				eq(ManagedDomain.organizationId, organizationId),
				eq(ManagedDomain.fqdn, trimDnsName(fqdn)),
			),
		)
		.limit(1)
	return row ?? null
}

export async function listManagedDomains(organizationId: string) {
	return db
		.select()
		.from(ManagedDomain)
		.where(eq(ManagedDomain.organizationId, organizationId))
}

export async function listDomainRecords(managedDomainId: string) {
	const rows = await db
		.select()
		.from(DomainRecord)
		.where(eq(DomainRecord.managedDomainId, managedDomainId))
	return rows.sort(
		(a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type),
	)
}

/** Saves a record at the provider and in our table; the one place records are written. */
export async function writeRecord(
	domain: ManagedDomainRow,
	record: ZoneRecord,
	source: 'imported' | 'user' | 'managed',
): Promise<DomainRecordRow> {
	const provider = getDomainAdapters().dns
	const remote = domain.zoneId
		? await provider.createRecord(domain.zoneId, record)
		: null
	const [row] = await db
		.insert(DomainRecord)
		.values({
			managedDomainId: domain.id,
			type: record.type,
			name: trimDnsName(record.name),
			content: record.content,
			ttl: record.ttl ?? 1,
			priority: record.priority ?? null,
			proxied: record.proxied ?? false,
			managedBy: record.managedBy ?? null,
			source,
			providerRecordId: remote?.id ?? null,
		})
		.returning()
	return row!
}

export type ConnectNameserversInput = {
	organization: { id: string; slug: string }
	/** What the operator typed (`example.com` or `www.example.com`). */
	hostname: string
	primaryForm: PrimaryForm
	scan: ZoneScan
	/** The domain typed back, when the scan says email may need attention. */
	emailConfirmation?: string | null
	actor: Actor
}

/**
 * "Let Menuza manage this domain": scans, refuses to go on silently when email
 * might be lost, creates the zone with every existing record (mail untouched),
 * and sets the site hosts up on it. The site stays on the old setup until the
 * nameservers are seen at the registrar.
 */
export async function connectByNameservers(input: ConnectNameserversInput) {
	const parts = describeHostname(input.hostname.trim().toLowerCase())
	const plan = hostsForConnect(
		input.hostname.trim().toLowerCase(),
		input.primaryForm,
	)
	if (!parts || !plan) throw new DomainError('hostname_invalid')
	if (parts.role === 'subdomain') throw new ZoneError('subdomain_not_allowed')
	const domain = parts.apex
	assertHostAllowed(domain)
	if (
		input.scan.emailSafety === 'attention' &&
		!emailConfirmationMatches(input.emailConfirmation ?? '', domain)
	) {
		throw new ZoneError('email_confirmation_required')
	}
	const [taken] = await db
		.select({ organizationId: ManagedDomain.organizationId })
		.from(ManagedDomain)
		.where(eq(ManagedDomain.fqdn, domain))
		.limit(1)
	if (taken) {
		throw taken.organizationId === input.organization.id
			? new ZoneError('zone_exists')
			: new DomainError('hostname_taken', undefined, domain)
	}

	const dns = getDomainAdapters().dns
	let zone
	try {
		zone = await dns.createZone(domain)
	} catch {
		throw new ZoneError('zone_failed')
	}
	const [created] = await db
		.insert(ManagedDomain)
		.values({
			organizationId: input.organization.id,
			fqdn: domain,
			source: 'nameservers',
			zoneProvider: dns.name,
			zoneId: zone.zoneId,
			nameservers: JSON.stringify(zone.nameservers),
			zoneStatus: zone.status === 'active' ? 'active' : 'pending',
			nsPendingSince: new Date(),
			scan: JSON.stringify({
				scannedAt: input.scan.scannedAt,
				mail: input.scan.mail,
				emailSafety: input.scan.emailSafety,
				zoneFile: input.scan.zoneFile,
				recordCount: input.scan.records.length,
			}),
			emailRiskConfirmedAt:
				input.scan.emailSafety === 'attention' ? new Date() : null,
		})
		.returning()
	const managed = created!

	// Every record the scan found comes with the domain, except the website
	// records of the hosts being connected: those become the site records below.
	const siteHosts = [plan.primary, ...plan.redirects]
	for (const record of input.scan.records) {
		if (record.type === 'NS' || isSiteHostRecord(record, siteHosts)) continue
		await writeRecord(managed, record, 'imported').catch((error) => {
			console.error(
				'Importing a DNS record failed:',
				error instanceof Error ? error.message : error,
			)
		})
	}

	const existing = await ensureSiteDomains(input.organization.id)
	const sites = await addSiteDomains({
		organization: input.organization,
		hostname: input.hostname,
		primaryForm: input.primaryForm,
		mode: primaryOf(existing) ? 'redirect' : 'primary',
		actor: input.actor,
		managedDomainId: managed.id,
		method: 'nameservers',
	})
	await syncSiteRecords(managed.id)
	await logZone(
		input.organization.id,
		input.actor,
		`Moved ${domain} to Menuza nameservers. Mail records kept.`,
		{
			domain,
			emailSafety: input.scan.emailSafety,
			hosts: sites.map((s) => s.hostname),
		},
	)
	return { domain: managed, nameservers: zone.nameservers, sites }
}

/** The managed zone's site records follow the SiteDomain hosts that use it. */
export async function syncSiteRecords(managedDomainId: string) {
	const [domain] = await db
		.select()
		.from(ManagedDomain)
		.where(eq(ManagedDomain.id, managedDomainId))
		.limit(1)
	if (!domain) return
	const sites = await db
		.select()
		.from(SiteDomain)
		.where(eq(SiteDomain.managedDomainId, domain.id))
	const hosts = sites
		.filter((site) => site.status !== 'expired')
		.map((site) => site.hostname)
	const changes = planSiteRecords({
		hostnames: hosts,
		cnameTarget: siteCnameTarget(),
		apexOf: (host) => describeHostname(host)?.apex ?? host,
		apexIps: siteApexIps(),
		apexMode: 'alias',
	})
	const wanted = changes.map((change): ZoneRecord => ({
		type: change.type,
		name: change.name,
		content: change.content,
		ttl: 1,
		managedBy: 'site',
	}))
	const records = await listDomainRecords(domain.id)
	const provider = getDomainAdapters().dns
	// Site records that no host needs any more go.
	for (const row of records.filter((r) => r.managedBy === 'site')) {
		if (
			!wanted.some(
				(w) =>
					w.type === row.type &&
					trimDnsName(w.name) === row.name &&
					w.content === row.content,
			)
		) {
			if (domain.zoneId && row.providerRecordId) {
				await provider
					.deleteRecord(domain.zoneId, row.providerRecordId)
					.catch(() => undefined)
			}
			await db.delete(DomainRecord).where(eq(DomainRecord.id, row.id))
		}
	}
	for (const record of wanted) {
		const have = records.find(
			(row) =>
				row.managedBy === 'site' &&
				row.type === record.type &&
				row.name === trimDnsName(record.name) &&
				row.content === record.content,
		)
		if (have) continue
		// A name keeps one site record: replace what an import left at the host.
		for (const clash of records.filter(
			(row) =>
				row.name === trimDnsName(record.name) &&
				['A', 'AAAA', 'CNAME'].includes(row.type) &&
				row.managedBy !== 'site',
		)) {
			if (domain.zoneId && clash.providerRecordId) {
				await provider
					.deleteRecord(domain.zoneId, clash.providerRecordId)
					.catch(() => undefined)
			}
			await db.delete(DomainRecord).where(eq(DomainRecord.id, clash.id))
		}
		await writeRecord(domain, record, 'managed')
	}
}

// ---------------------------------------------------------------------------
// Checking the nameservers
// ---------------------------------------------------------------------------

export type NameserverState =
	/** The registrar points at us. */
	| 'verified'
	/** The registrar's answer has not changed yet. */
	| 'waiting'
	/** The registrar points at nameservers that are not ours. */
	| 'wrong_place'

export type ManagedDomainCheck = {
	row: ManagedDomainRow
	state: NameserverState
	current: string[]
	expected: string[]
	becameActive: boolean
}

export function nameserversOf(row: ManagedDomainRow): string[] {
	try {
		return JSON.parse(row.nameservers ?? '[]') as string[]
	} catch {
		return []
	}
}

/** Looks for our nameservers at the registrar and updates the zone's status. */
export async function checkManagedDomain(
	row: ManagedDomainRow,
	options: { resolver?: DnsResolver; now?: Date } = {},
): Promise<ManagedDomainCheck> {
	const now = options.now ?? new Date()
	const resolver = options.resolver ?? getDnsResolver()
	const provider = getDomainAdapters().dns
	const expected = nameserversOf(row).map(trimDnsName)
	const current = await lookupNameservers(resolver, row.fqdn)
	if (row.zoneId)
		await provider.recheckZone?.(row.zoneId).catch(() => undefined)
	const zone = row.zoneId
		? await provider.getZone(row.zoneId).catch(() => null)
		: null

	const publicMatch =
		current.length > 0 &&
		expected.length > 0 &&
		current.every((ns) => expected.includes(ns))
	const verified = publicMatch || zone?.status === 'active'
	const state: NameserverState = verified
		? 'verified'
		: current.length > 0
			? 'wrong_place'
			: 'waiting'
	const zoneStatus = verified
		? 'active'
		: row.zoneStatus === 'active'
			? 'moved'
			: row.zoneStatus === 'moved'
				? 'moved'
				: 'pending'
	const [updated] = await db
		.update(ManagedDomain)
		.set({
			zoneStatus,
			nsCheckedAt: now,
			nsVerifiedAt: verified ? (row.nsVerifiedAt ?? now) : row.nsVerifiedAt,
		})
		.where(eq(ManagedDomain.id, row.id))
		.returning()
	const saved = updated ?? row
	const becameActive = verified && row.zoneStatus !== 'active'
	if (becameActive) {
		// The site's hosts can now validate: look at them straight away.
		const sites = await db
			.select()
			.from(SiteDomain)
			.where(eq(SiteDomain.managedDomainId, row.id))
		for (const site of sites) {
			if (site.status === 'pending') {
				await checkAndNotify(site, { resolver, now }).catch(() => undefined)
			}
		}
	}
	return { row: saved, state, current, expected, becameActive }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

async function loadOwned(organizationId: string, managedDomainId: string) {
	const [domain] = await db
		.select()
		.from(ManagedDomain)
		.where(
			and(
				eq(ManagedDomain.id, managedDomainId),
				eq(ManagedDomain.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!domain) throw new ZoneError('domain_not_found')
	return domain
}

export type RecordInput = Omit<ZoneRecord, 'id' | 'managedBy'>

export async function addZoneRecord(input: {
	organizationId: string
	managedDomainId: string
	record: RecordInput
	actor: Actor
}) {
	const domain = await loadOwned(input.organizationId, input.managedDomainId)
	const existing = (await listDomainRecords(domain.id)).map(toZoneRecord)
	const issues = validateRecord({
		domain: domain.fqdn,
		existing,
		next: input.record,
	})
	if (issues.length > 0) throw new ZoneError('invalid_record', issues)
	const row = await writeRecord(
		domain,
		{ ...input.record, name: trimDnsName(input.record.name) },
		'user',
	)
	await logZone(
		input.organizationId,
		input.actor,
		`Added a ${row.type} record for ${row.name} on ${domain.fqdn}.`,
		{
			domain: domain.fqdn,
			change: 'add',
			type: row.type,
			name: row.name,
			content: row.content,
		},
	)
	return row
}

export async function updateZoneRecord(input: {
	organizationId: string
	managedDomainId: string
	recordId: string
	record: RecordInput
	actor: Actor
}) {
	const domain = await loadOwned(input.organizationId, input.managedDomainId)
	const rows = await listDomainRecords(domain.id)
	const current = rows.find((row) => row.id === input.recordId)
	if (!current) throw new ZoneError('domain_not_found')
	const issues = validateRecord({
		domain: domain.fqdn,
		existing: rows.map(toZoneRecord),
		next: input.record,
		editing: toZoneRecord(current),
	})
	if (issues.length > 0) {
		throw new ZoneError(
			issues.some((i) => i.code === 'managed_readonly')
				? 'managed_readonly'
				: 'invalid_record',
			issues,
		)
	}
	const next = { ...input.record, name: trimDnsName(input.record.name) }
	if (domain.zoneId && current.providerRecordId) {
		await getDomainAdapters().dns.updateRecord(
			domain.zoneId,
			current.providerRecordId,
			next,
		)
	}
	const [row] = await db
		.update(DomainRecord)
		.set({
			type: next.type,
			name: next.name,
			content: next.content,
			ttl: next.ttl ?? 1,
			priority: next.priority ?? null,
			proxied: next.proxied ?? false,
		})
		.where(eq(DomainRecord.id, current.id))
		.returning()
	await logZone(
		input.organizationId,
		input.actor,
		`Changed the ${current.type} record for ${current.name} on ${domain.fqdn}.`,
		{
			domain: domain.fqdn,
			change: 'update',
			from: {
				type: current.type,
				name: current.name,
				content: current.content,
			},
			to: { type: next.type, name: next.name, content: next.content },
		},
	)
	return row!
}

export async function deleteZoneRecord(input: {
	organizationId: string
	managedDomainId: string
	recordId: string
	actor: Actor
}) {
	const domain = await loadOwned(input.organizationId, input.managedDomainId)
	const rows = await listDomainRecords(domain.id)
	const current = rows.find((row) => row.id === input.recordId)
	if (!current) throw new ZoneError('domain_not_found')
	const issues = validateRecordRemoval(toZoneRecord(current))
	if (issues.length > 0) throw new ZoneError('managed_readonly', issues)
	if (domain.zoneId && current.providerRecordId) {
		await getDomainAdapters().dns.deleteRecord(
			domain.zoneId,
			current.providerRecordId,
		)
	}
	await db.delete(DomainRecord).where(eq(DomainRecord.id, current.id))
	await logZone(
		input.organizationId,
		input.actor,
		`Removed the ${current.type} record for ${current.name} on ${domain.fqdn}.`,
		{
			domain: domain.fqdn,
			change: 'delete',
			type: current.type,
			name: current.name,
			content: current.content,
		},
	)
}

export async function exportManagedZone(
	organizationId: string,
	managedDomainId: string,
) {
	const domain = await loadOwned(organizationId, managedDomainId)
	const rows = await listDomainRecords(domain.id)
	return { domain, text: exportZoneFile(domain.fqdn, rows.map(toZoneRecord)) }
}

/**
 * Leaving: exports the zone and switches the domain's hosts back to the CNAME
 * method. The operator re-points the nameservers at the old DNS host and adds
 * the site records from the checklist; a domain we registered stays with us
 * (it can be transferred out instead).
 */
export async function leaveManagedZone(input: {
	organization: { id: string; slug: string }
	managedDomainId: string
	actor: Actor
}) {
	const domain = await loadOwned(input.organization.id, input.managedDomainId)
	if (domain.source !== 'nameservers') throw new ZoneError('registered_here')
	if (domain.emailForwardingEnabledAt) throw new ZoneError('forwarding_active')
	const { text } = await exportManagedZone(input.organization.id, domain.id)
	if (domain.zoneId) {
		await getDomainAdapters()
			.dns.deleteZone(domain.zoneId)
			.catch(() => undefined)
	}
	await db
		.update(SiteDomain)
		.set({ method: 'cname', managedDomainId: null })
		.where(eq(SiteDomain.managedDomainId, domain.id))
	await db.delete(ManagedDomain).where(eq(ManagedDomain.id, domain.id))
	await logZone(
		input.organization.id,
		input.actor,
		`Stopped managing ${domain.fqdn}; its hosts use the CNAME method again.`,
		{ domain: domain.fqdn, change: 'leave' },
	)
	return { text, domain: domain.fqdn }
}

export function managedDomainSites(
	rows: SiteDomainRow[],
	managedDomainId: string,
) {
	return rows.filter((row) => row.managedDomainId === managedDomainId)
}

export { changeTouchesMail }

/** Removes a record of ours (a managed one) at the provider and in our table. */
export async function removeRecordRow(
	domain: ManagedDomainRow,
	row: DomainRecordRow,
) {
	if (domain.zoneId && row.providerRecordId) {
		await getDomainAdapters()
			.dns.deleteRecord(domain.zoneId, row.providerRecordId)
			.catch(() => undefined)
	}
	await db.delete(DomainRecord).where(eq(DomainRecord.id, row.id))
}

/** Changes a record of ours without the operator rules (SPF merging, managed records). */
export async function replaceRecordRow(
	domain: ManagedDomainRow,
	row: DomainRecordRow,
	next: Partial<Pick<ZoneRecord, 'content' | 'managedBy'>>,
) {
	const merged: ZoneRecord = { ...toZoneRecord(row), ...next }
	if (domain.zoneId && row.providerRecordId) {
		await getDomainAdapters().dns.updateRecord(
			domain.zoneId,
			row.providerRecordId,
			merged,
		)
	}
	const [updated] = await db
		.update(DomainRecord)
		.set({ content: merged.content, managedBy: merged.managedBy ?? null })
		.where(eq(DomainRecord.id, row.id))
		.returning()
	return updated!
}

/**
 * Reads the zone back from the provider and adds what we do not have (records
 * a provider wrote itself, such as Cloudflare's email routing MX). Records the
 * provider calls its own are marked as managed so the operator cannot change them.
 */
export async function importProviderRecords(
	domain: ManagedDomainRow,
	classify: (record: ZoneRecord) => ZoneRecord['managedBy'] = () => null,
) {
	if (!domain.zoneId) return
	const remote = await getDomainAdapters().dns.listRecords(domain.zoneId)
	const have = await listDomainRecords(domain.id)
	for (const record of remote) {
		if (have.some((row) => row.providerRecordId === record.id)) continue
		if (record.type === 'NS' && trimDnsName(record.name) === domain.fqdn)
			continue
		await db.insert(DomainRecord).values({
			managedDomainId: domain.id,
			type: record.type,
			name: trimDnsName(record.name),
			content: record.content,
			ttl: record.ttl ?? 1,
			priority: record.priority ?? null,
			proxied: record.proxied ?? false,
			managedBy: classify(record) ?? null,
			source: 'imported',
			providerRecordId: record.id,
		})
	}
}

/**
 * One SPF record per name, a sender merged in rather than a second record
 * added: used by email forwarding (#276) and sending domains (#103). A record
 * the operator already has stays theirs; one we create is ours (read-only).
 */
export async function mergeSpfMechanism(
	domain: ManagedDomainRow,
	name: string,
	mechanism: string,
	managedBy: NonNullable<ZoneRecord['managedBy']>,
) {
	const at = trimDnsName(name)
	const rows = (await listDomainRecords(domain.id)).filter(
		(row) => row.type === 'TXT' && row.name === at && isSpf(row.content),
	)
	if (rows.length === 0) {
		await writeRecord(
			domain,
			{
				type: 'TXT',
				name: at,
				content: mergeSpf(null, [mechanism]),
				managedBy,
			},
			'managed',
		)
		return
	}
	// Several (a provider added its own beside the operator's): fold into the first.
	const [keep, ...extras] = rows as [DomainRecordRow, ...DomainRecordRow[]]
	let merged = keep.content
	for (const extra of extras) {
		merged = mergeSpf(merged, spfMechanisms(extra.content))
		await removeRecordRow(domain, extra)
	}
	merged = mergeSpf(merged, [mechanism])
	if (merged !== keep.content)
		await replaceRecordRow(domain, keep, { content: merged })
}

/**
 * Looks at every zone that is waiting for its nameservers (so the site goes
 * live without a click once the registrar changed) and at registered domains
 * whose owner email the registry has not confirmed yet.
 */
export async function sweepManagedDomains(
	options: { now?: Date; resolver?: DnsResolver; limit?: number } = {},
) {
	const now = options.now ?? new Date()
	const counts = { checked: 0, active: 0, errors: 0 }
	const rows = await db
		.select()
		.from(ManagedDomain)
		.where(inArray(ManagedDomain.zoneStatus, ['pending', 'moved']))
		.limit(options.limit ?? 100)
	for (const row of rows) {
		if (!row.zoneId) continue
		try {
			const result = await checkManagedDomain(row, {
				now,
				resolver: options.resolver,
			})
			counts.checked += 1
			if (result.becameActive) counts.active += 1
		} catch (error) {
			counts.errors += 1
			console.error(
				'Nameserver check failed:',
				row.id,
				error instanceof Error ? error.message : error,
			)
		}
	}
	return counts
}
