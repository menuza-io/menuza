import crypto from 'node:crypto'
import { spfMechanisms, isSpf } from '@repo/common/domain-zone'
import { describeHostname, trimDnsName } from '@repo/common/domains'
import {
	isPlainEmailAddress,
	isValidSenderDomain,
	isValidSenderLocalPart,
	validateSenderName,
	type OrganizationEmailIdentity,
	type SenderFailure,
} from '@repo/common/email-sender'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	and,
	db,
	eq,
	isNotNull,
	ManagedDomain,
	Organization,
	OrganizationEmailSender,
	sql,
} from '@repo/database'
import {
	type EmailDomainRecord,
	ReplyToVerificationEmail,
	sendEmail,
} from '@repo/email'
import { createElement } from 'react'
import {
	getDnsResolver,
	lookupTxt,
	type DnsResolver,
} from '#app/utils/domains/dns-resolver.server.ts'
import { notifyDomainEvent } from '#app/utils/domains/notify.server.ts'
import {
	listDomainRecords,
	mergeSpfMechanism,
	removeRecordRow,
	replaceRecordRow,
	writeRecord,
} from '#app/utils/domains/zone.server.ts'
import { getSenderDomainClient } from './node-client.server.ts'

/**
 * Email sending (#103): the sender name guests see, a reply-to the operator
 * proved with a code, and an optional custom sending domain with SPF, DKIM
 * and return-path records. Until the domain is verified the platform address
 * is used (with the organization's name and reply-to); once verified the
 * region sends from `<local part>@<their domain>`; if the records later
 * disappear it falls back and the operator is told.
 */

export const CUSTOM_SENDER_FLAG = 'messaging.custom_sender'
export const REPLY_TO_CODE_MINUTES = 15
export const REPLY_TO_MAX_ATTEMPTS = 5
export const REPLY_TO_RESEND_SECONDS = 60
const DAY = 86_400_000

export type SenderFlowFailure =
	| SenderFailure
	| 'feature_off'
	| 'code_invalid'
	| 'code_expired'
	| 'too_many_attempts'
	| 'resend_too_soon'
	| 'no_pending_reply_to'
	| 'provider_failed'
	| 'no_domain'

export class SenderFlowError extends Error {
	constructor(readonly code: SenderFlowFailure) {
		super(code)
		this.name = 'SenderFlowError'
	}
}

export type SenderRow = typeof OrganizationEmailSender.$inferSelect

export type StoredRecord = EmailDomainRecord & { found?: boolean }

async function ensureRow(organizationId: string): Promise<SenderRow> {
	const [existing] = await db
		.select()
		.from(OrganizationEmailSender)
		.where(eq(OrganizationEmailSender.organizationId, organizationId))
		.limit(1)
	if (existing) return existing
	const [created] = await db
		.insert(OrganizationEmailSender)
		.values({ organizationId })
		.onConflictDoNothing()
		.returning()
	if (created) return created
	const [raced] = await db
		.select()
		.from(OrganizationEmailSender)
		.where(eq(OrganizationEmailSender.organizationId, organizationId))
		.limit(1)
	return raced!
}

export async function getSenderRow(organizationId: string) {
	const [row] = await db
		.select()
		.from(OrganizationEmailSender)
		.where(eq(OrganizationEmailSender.organizationId, organizationId))
		.limit(1)
	return row ?? null
}

export function parseStoredRecords(
	row: Pick<SenderRow, 'dnsRecords'> | null,
): StoredRecord[] {
	if (!row?.dnsRecords) return []
	try {
		return (
			(JSON.parse(row.dnsRecords) as { records?: StoredRecord[] }).records ?? []
		)
	} catch {
		return []
	}
}

async function customSenderOn(organizationId: string) {
	return (await getFeatureFlag(CUSTOM_SENDER_FLAG, { organizationId })) === true
}

// ---------------------------------------------------------------------------
// Sender name and the identity the region reads
// ---------------------------------------------------------------------------

export async function saveSenderName(
	organizationId: string,
	input: string | null,
) {
	const checked = validateSenderName(input)
	if (!checked.ok) throw new SenderFlowError(checked.code)
	await ensureRow(organizationId)
	const [row] = await db
		.update(OrganizationEmailSender)
		.set({ senderName: checked.value })
		.where(eq(OrganizationEmailSender.organizationId, organizationId))
		.returning()
	return row!
}

/**
 * What the region needs to send as this organization: the name, the verified
 * reply-to, and the sending address only while the domain is verified, in the
 * organization's current region, and the feature is on. `null`: nothing set.
 */
export async function buildEmailIdentity(
	organizationId: string,
): Promise<OrganizationEmailIdentity | null> {
	const row = await getSenderRow(organizationId)
	if (!row) return null
	const [org] = await db
		.select({ dataRegion: Organization.dataRegion })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	const domainLive =
		row.domainStatus === 'verified' &&
		Boolean(row.domain) &&
		(row.dataRegion ?? 'us') === (org?.dataRegion ?? 'us') &&
		(await customSenderOn(organizationId))
	return {
		senderName: row.senderName,
		replyTo: row.replyToVerifiedAt ? row.replyTo : null,
		fromEmail: domainLive ? `${row.localPart}@${row.domain}` : null,
	}
}

// ---------------------------------------------------------------------------
// Reply-to, verified by a code
// ---------------------------------------------------------------------------

function hashCode(organizationId: string, code: string) {
	return crypto
		.createHash('sha256')
		.update(`${organizationId}:${code}`)
		.digest('hex')
}

/** Sends a six-digit code to the address; it becomes the reply-to when entered. */
export async function requestReplyToCode(input: {
	organization: { id: string; name: string }
	address: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	const address = input.address.trim().toLowerCase()
	if (!isPlainEmailAddress(address))
		throw new SenderFlowError('invalid_reply_to')
	const row = await ensureRow(input.organization.id)
	if (
		row.replyToCodeSentAt &&
		row.pendingReplyTo === address &&
		now.getTime() - row.replyToCodeSentAt.getTime() <
			REPLY_TO_RESEND_SECONDS * 1000
	) {
		throw new SenderFlowError('resend_too_soon')
	}
	const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
	await db
		.update(OrganizationEmailSender)
		.set({
			pendingReplyTo: address,
			replyToCodeHash: hashCode(input.organization.id, code),
			replyToCodeExpiresAt: new Date(
				now.getTime() + REPLY_TO_CODE_MINUTES * 60_000,
			),
			replyToCodeAttempts: 0,
			replyToCodeSentAt: now,
		})
		.where(eq(OrganizationEmailSender.organizationId, input.organization.id))
	const result = await sendEmail({
		to: address,
		subject: `Your code to confirm the reply-to for ${input.organization.name}`,
		react: createElement(ReplyToVerificationEmail, {
			organizationName: input.organization.name,
			code,
			minutesValid: REPLY_TO_CODE_MINUTES,
		}),
	})
	if (result.status === 'error') throw new SenderFlowError('provider_failed')
}

/**
 * Checks the code. A new reply-to replaces the old one only now, so replies
 * keep going to the old verified address until the new one is proven.
 */
export async function verifyReplyToCode(input: {
	organizationId: string
	code: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	const row = await getSenderRow(input.organizationId)
	if (
		!row?.pendingReplyTo ||
		!row.replyToCodeHash ||
		!row.replyToCodeExpiresAt
	) {
		throw new SenderFlowError('no_pending_reply_to')
	}
	if (row.replyToCodeExpiresAt.getTime() < now.getTime())
		throw new SenderFlowError('code_expired')
	if (row.replyToCodeAttempts >= REPLY_TO_MAX_ATTEMPTS) {
		throw new SenderFlowError('too_many_attempts')
	}
	// Count the attempt first, so a parallel flood cannot try more than the limit.
	const [counted] = await db
		.update(OrganizationEmailSender)
		.set({
			replyToCodeAttempts: sql`${OrganizationEmailSender.replyToCodeAttempts} + 1`,
		})
		.where(
			and(
				eq(OrganizationEmailSender.organizationId, input.organizationId),
				sql`${OrganizationEmailSender.replyToCodeAttempts} < ${REPLY_TO_MAX_ATTEMPTS}`,
			),
		)
		.returning({ attempts: OrganizationEmailSender.replyToCodeAttempts })
	if (!counted) throw new SenderFlowError('too_many_attempts')
	const given = Buffer.from(hashCode(input.organizationId, input.code.trim()))
	const wanted = Buffer.from(row.replyToCodeHash)
	if (
		given.length !== wanted.length ||
		!crypto.timingSafeEqual(given, wanted)
	) {
		throw new SenderFlowError('code_invalid')
	}
	const [updated] = await db
		.update(OrganizationEmailSender)
		.set({
			replyTo: row.pendingReplyTo,
			replyToVerifiedAt: now,
			pendingReplyTo: null,
			replyToCodeHash: null,
			replyToCodeExpiresAt: null,
			replyToCodeAttempts: 0,
		})
		.where(eq(OrganizationEmailSender.organizationId, input.organizationId))
		.returning()
	return updated!
}

export async function clearReplyTo(organizationId: string) {
	await ensureRow(organizationId)
	await db
		.update(OrganizationEmailSender)
		.set({
			replyTo: null,
			replyToVerifiedAt: null,
			pendingReplyTo: null,
			replyToCodeHash: null,
			replyToCodeExpiresAt: null,
			replyToCodeAttempts: 0,
		})
		.where(eq(OrganizationEmailSender.organizationId, organizationId))
}

// ---------------------------------------------------------------------------
// The custom sending domain
// ---------------------------------------------------------------------------

async function managedZoneFor(organizationId: string, domain: string) {
	const apex = describeHostname(domain)?.apex
	if (!apex) return null
	const [row] = await db
		.select()
		.from(ManagedDomain)
		.where(
			and(
				eq(ManagedDomain.organizationId, organizationId),
				eq(ManagedDomain.fqdn, apex),
				isNotNull(ManagedDomain.zoneId),
			),
		)
		.limit(1)
	return row && row.zoneStatus !== 'moved' && row.zoneStatus !== 'failed'
		? row
		: null
}

/** If Menuza already hosts this domain's DNS, the records are written for them. */
async function writeRecordsToZone(
	organizationId: string,
	domain: string,
	records: EmailDomainRecord[],
) {
	const zone = await managedZoneFor(organizationId, domain)
	if (!zone) return false
	for (const record of records) {
		const name = trimDnsName(record.name)
		const exists = (await listDomainRecords(zone.id)).some(
			(row) =>
				row.type === record.type &&
				row.name === name &&
				row.content === record.value,
		)
		if (exists) continue
		if (record.type === 'TXT' && isSpf(record.value)) {
			for (const mechanism of spfMechanisms(record.value)) {
				await mergeSpfMechanism(zone, name, mechanism, 'email_sending')
			}
			continue
		}
		await writeRecord(
			zone,
			{
				type: record.type,
				name,
				content: record.value,
				priority: record.priority ?? null,
				managedBy: 'email_sending',
			},
			'managed',
		)
	}
	return true
}

async function removeRecordsFromZone(
	organizationId: string,
	domain: string,
	records: EmailDomainRecord[],
) {
	const zone = await managedZoneFor(organizationId, domain)
	if (!zone) return
	const spfMechanismsOurs = records
		.filter((record) => record.type === 'TXT' && isSpf(record.value))
		.flatMap((record) =>
			spfMechanisms(record.value).map((m) => m.toLowerCase()),
		)
	for (const row of await listDomainRecords(zone.id)) {
		if (row.managedBy === 'email_sending') {
			await removeRecordRow(zone, row)
		} else if (
			row.type === 'TXT' &&
			isSpf(row.content) &&
			spfMechanismsOurs.length > 0
		) {
			const kept = row.content
				.split(/\s+/u)
				.filter((part) => !spfMechanismsOurs.includes(part.toLowerCase()))
				.join(' ')
			if (kept !== row.content)
				await replaceRecordRow(zone, row, { content: kept })
		}
	}
}

export async function startSenderDomain(input: {
	organization: { id: string; name: string }
	domain: string
	localPart?: string
	resolver?: DnsResolver
	now?: Date
}) {
	if (!(await customSenderOn(input.organization.id)))
		throw new SenderFlowError('feature_off')
	const domain = input.domain.trim().toLowerCase().replace(/\.$/u, '')
	const localPart = input.localPart?.trim().toLowerCase() || 'hello'
	if (!isValidSenderDomain(domain)) throw new SenderFlowError('invalid_domain')
	if (!isValidSenderLocalPart(localPart))
		throw new SenderFlowError('invalid_local_part')
	const [taken] = await db
		.select({ organizationId: OrganizationEmailSender.organizationId })
		.from(OrganizationEmailSender)
		.where(eq(OrganizationEmailSender.domain, domain))
		.limit(1)
	if (taken && taken.organizationId !== input.organization.id) {
		throw new SenderFlowError('domain_in_use')
	}
	const [org] = await db
		.select({ dataRegion: Organization.dataRegion })
		.from(Organization)
		.where(eq(Organization.id, input.organization.id))
		.limit(1)
	const dataRegion = org?.dataRegion === 'ksa' ? 'ksa' : 'us'
	const current = await ensureRow(input.organization.id)
	const client = getSenderDomainClient()
	// One custom domain per organization: a new one replaces the old one.
	if (current.domain && current.providerRef && current.domain !== domain) {
		await removeSenderDomain(input.organization.id)
	}
	let registration
	try {
		registration = await client.register({
			organizationId: input.organization.id,
			dataRegion,
			domain,
			localPart,
		})
	} catch {
		throw new SenderFlowError('provider_failed')
	}
	try {
		await db
			.update(OrganizationEmailSender)
			.set({
				domain,
				localPart,
				domainStatus: 'pending',
				dkimSelector: registration.dkimSelector,
				providerRef: registration.providerRef,
				dnsRecords: JSON.stringify({
					records: registration.records.map((r) => ({ ...r, found: false })),
				}),
				dataRegion,
				checkedAt: null,
				verifiedAt: null,
				failedAt: null,
				fallbackNotifiedAt: null,
			})
			.where(eq(OrganizationEmailSender.organizationId, input.organization.id))
	} catch {
		await client
			.remove({ dataRegion, providerRef: registration.providerRef })
			.catch(() => undefined)
		throw new SenderFlowError('domain_in_use')
	}
	const wroteToZone = await writeRecordsToZone(
		input.organization.id,
		domain,
		registration.records,
	)
	const checked = await checkSenderDomain({
		organizationId: input.organization.id,
		resolver: input.resolver,
		now: input.now,
	})
	return { row: checked, wroteToZone }
}

async function recordFound(
	record: StoredRecord,
	resolver: DnsResolver,
): Promise<boolean> {
	const name = trimDnsName(record.name)
	if (record.type === 'TXT') {
		const values = await lookupTxt(resolver, name)
		if (isSpf(record.value)) {
			const wanted = spfMechanisms(record.value).map((m) => m.toLowerCase())
			return values.some(
				(value) =>
					isSpf(value) &&
					wanted.every((m) =>
						spfMechanisms(value)
							.map((x) => x.toLowerCase())
							.includes(m),
					),
			)
		}
		return values.includes(record.value)
	}
	if (record.type === 'CNAME') {
		return (await resolver(name, 'CNAME')).some(
			(answer) => trimDnsName(answer.data) === trimDnsName(record.value),
		)
	}
	return (await resolver(name, 'MX')).some((answer) =>
		answer.data.includes(trimDnsName(record.value)),
	)
}

/**
 * Looks at the records and asks the region's provider: Verified needs every
 * required record in public DNS and the provider's own confirmation. A verified
 * domain whose records vanish becomes Failed, sending falls back to the
 * platform address at once (the region reads the settings every minute), and
 * the operator is told once.
 */
export async function checkSenderDomain(input: {
	organizationId: string
	resolver?: DnsResolver
	now?: Date
}): Promise<SenderRow> {
	const now = input.now ?? new Date()
	const row = await getSenderRow(input.organizationId)
	if (!row?.domain || !row.providerRef) throw new SenderFlowError('no_domain')
	const resolver = input.resolver ?? getDnsResolver()
	const stored = parseStoredRecords(row)
	const found = await Promise.all(
		stored.map((record) => recordFound(record, resolver)),
	)
	const records = stored.map((record, index) => ({
		...record,
		found: found[index]!,
	}))
	let providerStatus: 'pending' | 'verified' | 'failed' = 'pending'
	try {
		providerStatus = (
			await getSenderDomainClient().check({
				dataRegion: row.dataRegion === 'ksa' ? 'ksa' : 'us',
				providerRef: row.providerRef,
				domain: row.domain,
				records: stored,
			})
		).status
	} catch {
		// The region could not answer: keep what we know, change nothing.
		return row
	}
	const allRequiredFound = records
		.filter((r) => r.required)
		.every((r) => r.found)
	const verified = allRequiredFound && providerStatus === 'verified'
	const wasVerified = row.domainStatus === 'verified'
	const status = verified
		? 'verified'
		: wasVerified || row.domainStatus === 'failed'
			? 'failed'
			: 'pending'
	const [updated] = await db
		.update(OrganizationEmailSender)
		.set({
			domainStatus: status,
			dnsRecords: JSON.stringify({ records }),
			checkedAt: now,
			verifiedAt: verified ? (row.verifiedAt ?? now) : row.verifiedAt,
			failedAt: status === 'failed' ? (row.failedAt ?? now) : null,
			fallbackNotifiedAt: verified ? null : row.fallbackNotifiedAt,
		})
		.where(eq(OrganizationEmailSender.organizationId, input.organizationId))
		.returning()
	if (wasVerified && status === 'failed') {
		const claimed = await db
			.update(OrganizationEmailSender)
			.set({ fallbackNotifiedAt: now })
			.where(
				and(
					eq(OrganizationEmailSender.organizationId, input.organizationId),
					sql`${OrganizationEmailSender.fallbackNotifiedAt} IS NULL`,
				),
			)
			.returning({ id: OrganizationEmailSender.id })
		if (claimed.length > 0) {
			await notifyDomainEvent({
				organizationId: input.organizationId,
				kind: 'sender_fallback',
				entityId: `${row.id}:${now.getTime()}`,
				host: row.domain,
			})
		}
	}
	return updated ?? row
}

export async function removeSenderDomain(organizationId: string) {
	const row = await getSenderRow(organizationId)
	if (!row?.domain) return
	if (row.providerRef) {
		await getSenderDomainClient()
			.remove({
				dataRegion: row.dataRegion === 'ksa' ? 'ksa' : 'us',
				providerRef: row.providerRef,
			})
			.catch(() => undefined)
	}
	await removeRecordsFromZone(
		organizationId,
		row.domain,
		parseStoredRecords(row),
	)
	await db
		.update(OrganizationEmailSender)
		.set({
			domain: null,
			domainStatus: 'none',
			dkimSelector: null,
			providerRef: null,
			dnsRecords: null,
			dataRegion: null,
			checkedAt: null,
			verifiedAt: null,
			failedAt: null,
			fallbackNotifiedAt: null,
		})
		.where(eq(OrganizationEmailSender.organizationId, organizationId))
}

/**
 * The data region changed: the domain was set up at the old region's provider,
 * so it is removed there and registered again in the new one. It is Pending
 * until its new records (they differ per region) are in DNS and verified.
 */
export async function resetSenderDomainForRegionChange(
	organizationId: string,
	newRegion: 'us' | 'ksa',
) {
	const row = await getSenderRow(organizationId)
	if (!row?.domain) return null
	const domain = row.domain
	const localPart = row.localPart
	if (row.providerRef) {
		await getSenderDomainClient()
			.remove({
				dataRegion: row.dataRegion === 'ksa' ? 'ksa' : 'us',
				providerRef: row.providerRef,
			})
			.catch(() => undefined)
	}
	await removeRecordsFromZone(organizationId, domain, parseStoredRecords(row))
	let registration = null
	try {
		registration = await getSenderDomainClient().register({
			organizationId,
			dataRegion: newRegion,
			domain,
			localPart,
		})
	} catch {
		registration = null
	}
	await db
		.update(OrganizationEmailSender)
		.set({
			domainStatus: registration ? 'pending' : 'failed',
			dkimSelector: registration?.dkimSelector ?? null,
			providerRef: registration?.providerRef ?? null,
			dnsRecords: registration
				? JSON.stringify({
						records: registration.records.map((r) => ({ ...r, found: false })),
					})
				: null,
			dataRegion: newRegion,
			checkedAt: null,
			verifiedAt: null,
			failedAt: registration ? null : new Date(),
			fallbackNotifiedAt: null,
		})
		.where(eq(OrganizationEmailSender.organizationId, organizationId))
	if (registration) {
		await writeRecordsToZone(organizationId, domain, registration.records)
	}
	return registration
}

/**
 * Looks at every sending domain: pending ones until they verify, verified ones
 * once a day (so a removed record is noticed, the sender falls back, and the
 * operator hears about it).
 */
export async function sweepSenderDomains(
	options: {
		now?: Date
		resolver?: DnsResolver
		limit?: number
	} = {},
) {
	const now = options.now ?? new Date()
	const rows = await db
		.select()
		.from(OrganizationEmailSender)
		.where(isNotNull(OrganizationEmailSender.providerRef))
		.limit(options.limit ?? 100)
	const counts = { checked: 0, verified: 0, failed: 0 }
	for (const row of rows) {
		const due =
			row.domainStatus !== 'verified' ||
			!row.checkedAt ||
			now.getTime() - row.checkedAt.getTime() >= DAY - 60_000
		if (!due) continue
		try {
			const result = await checkSenderDomain({
				organizationId: row.organizationId,
				resolver: options.resolver,
				now,
			})
			counts.checked += 1
			if (result.domainStatus === 'verified' && row.domainStatus !== 'verified')
				counts.verified += 1
			if (result.domainStatus === 'failed' && row.domainStatus === 'verified')
				counts.failed += 1
		} catch {
			// One organization's failure never stops the rest.
		}
	}
	return counts
}

export async function senderView(organizationId: string) {
	const row = await getSenderRow(organizationId)
	const [org] = await db
		.select({ name: Organization.name })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return {
		organizationName: org?.name ?? '',
		senderName: row?.senderName ?? null,
		replyTo: row?.replyTo ?? null,
		replyToVerified: Boolean(row?.replyToVerifiedAt),
		pendingReplyTo: row?.pendingReplyTo ?? null,
		domain: row?.domain ?? null,
		localPart: row?.localPart ?? 'hello',
		domainStatus: (row?.domainStatus ?? 'none') as
			'none' | 'pending' | 'verified' | 'failed',
		records: parseStoredRecords(row ?? null),
		checkedAt: row?.checkedAt?.toISOString() ?? null,
		customSenderEnabled: await customSenderOn(organizationId),
		/** True when the records were written into a zone Menuza hosts. */
		managedDns: row?.domain
			? Boolean(await managedZoneFor(organizationId, row.domain))
			: false,
	}
}
