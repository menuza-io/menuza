import { describeHostname } from '@repo/common/domains'
import { db, desc, DomainJob, eq, ManagedDomain } from '@repo/database'
import { getDomainAdapters } from './adapters.select.server.ts'
import { siteApexIps, siteCnameTarget, supportedTlds } from './config.server.ts'
import {
	existingMailProvider,
	forwardingAvailability,
	listForwards,
	MAX_FORWARDS_PER_DOMAIN,
} from './forwarding.server.ts'
import {
	getDomainJobStatus,
	isRegistrarEnabled,
	retailCents,
} from './registrar.server.ts'
import { ensureSiteDomains, toSiteDomainView } from './site-domains.server.ts'
import { listDomainRecords, nameserversOf } from './zone.server.ts'

/** Everything the Website, Domain screen shows, as plain serializable data. */

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null

export async function loadDomainOverview(input: { organizationId: string }) {
	const orgId = input.organizationId
	const [siteRows, managedRows, registrarEnabled] = await Promise.all([
		ensureSiteDomains(orgId),
		db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.organizationId, orgId)),
		isRegistrarEnabled(orgId),
	])
	const adapters = getDomainAdapters()
	const siteDomains = siteRows.map((row) => toSiteDomainView(row))

	const managed = await Promise.all(
		managedRows.map(async (row) => {
			const [records, forwards, existingMail] = await Promise.all([
				listDomainRecords(row.id),
				listForwards(row.id),
				existingMailProvider(row.id),
			])
			const availability = forwardingAvailability(row)
			return {
				id: row.id,
				fqdn: row.fqdn,
				source: row.source,
				zoneStatus: row.zoneStatus,
				nameservers: nameserversOf(row),
				nsCheckedAt: iso(row.nsCheckedAt),
				registrationStatus: row.registrationStatus,
				expiresAt: iso(row.expiresAt),
				autoRenew: row.autoRenew,
				locked: row.locked,
				privacy: row.privacy,
				registrantConfirmed: Boolean(row.registrantEmailConfirmedAt),
				renewalFailedSince: iso(row.renewalFailedSince),
				records: records.map((record) => ({
					id: record.id,
					type: record.type,
					name: record.name,
					content: record.content,
					ttl: record.ttl,
					priority: record.priority,
					managedBy: record.managedBy,
					source: record.source,
				})),
				sites: siteRows
					.filter((site) => site.managedDomainId === row.id)
					.map((site) => site.hostname),
				forwarding: {
					enabled: Boolean(row.emailForwardingEnabledAt),
					availability,
					existingMail,
					max: MAX_FORWARDS_PER_DOMAIN,
					reportsActivity: Boolean(adapters.routing.lastForwardedAt),
					forwards: forwards.map((forward) => ({
						id: forward.id,
						localPart: forward.localPart,
						destination: forward.destination,
						status: forward.status,
						lastForwardedAt: iso(forward.lastForwardedAt),
						lastError: forward.lastError,
					})),
				},
			}
		}),
	)

	// Domains whose DNS is somewhere else: forwarding says why it is unavailable.
	const managedApexes = new Set(managedRows.map((row) => row.fqdn))
	const unmanaged = [
		...new Set(
			siteRows
				.map((row) => describeHostname(row.hostname)?.apex)
				.filter(
					(apex): apex is string => Boolean(apex) && !managedApexes.has(apex!),
				),
		),
	]

	const jobs = (
		await db
			.select({ id: DomainJob.id, createdAt: DomainJob.createdAt })
			.from(DomainJob)
			.where(eq(DomainJob.organizationId, orgId))
			.orderBy(desc(DomainJob.createdAt))
			.limit(5)
	).filter((job) => Date.now() - job.createdAt.getTime() < 7 * 86_400_000)
	const jobStatuses = (
		await Promise.all(jobs.map((job) => getDomainJobStatus(orgId, job.id)))
	).filter((status): status is NonNullable<typeof status> => status !== null)

	return {
		cnameTarget: siteCnameTarget(),
		apexIps: siteApexIps(),
		siteDomains,
		managed,
		unmanaged,
		registrar: {
			enabled: registrarEnabled,
			configured: adapters.registrar.isConfigured(),
			tlds: supportedTlds(),
			sampleYearlyCents: retailCents(1299),
		},
		jobs: jobStatuses,
	}
}

export type DomainOverview = Awaited<ReturnType<typeof loadDomainOverview>>
