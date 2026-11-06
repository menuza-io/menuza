import crypto from 'node:crypto'
import { brand } from '@repo/config/brand'
import {
	and,
	db,
	eq,
	isNull,
	like,
	ne,
	Organization,
	OrganizationInvitation,
	User,
	UserOrganization,
} from '@repo/database'
import {
	createOrganizationInvitation,
	sendOrganizationInvitationEmail,
} from './invitation.server.ts'

/**
 * Verified domains need proof that the organization controls the domain: a
 * TXT record holding a random token. A mailbox on the domain is not enough
 * (shared, university or reseller domains). Once proven, people already
 * signed up with an address on the domain are invited, never added silently;
 * new sign-ups on the domain still join, since their address was just
 * verified by code.
 */

/** Invitations sent per verification; the rest can be invited from Members. */
export const MAX_DOMAIN_INVITES = 100

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'

export function domainVerificationRecordName(domain: string) {
	return `_${brand.slug}-verify.${domain}`
}

export function domainVerificationRecordValue(token: string) {
	return `${brand.slug}-domain-verification=${token}`
}

export function newDomainVerificationToken() {
	return crypto.randomBytes(18).toString('base64url')
}

/** TXT strings for `name`, joined as resolvers split long records. */
export async function lookupTxtRecords(
	name: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
	const url = new URL(DOH_ENDPOINT)
	url.searchParams.set('name', name)
	url.searchParams.set('type', 'TXT')
	const response = await fetchImpl(url, {
		headers: { Accept: 'application/dns-json' },
		redirect: 'manual',
	})
	if (!response.ok) throw new Error(`DNS lookup failed (${response.status})`)
	const body = (await response.json()) as {
		Answer?: Array<{ type: number; data: string }>
	}
	return (body.Answer ?? [])
		.filter((answer) => answer.type === 16)
		.map(
			(answer) =>
				[...answer.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
					.map((match) => match[1])
					.join('') || answer.data,
		)
}

/** Whether another organization already holds the domain. */
export async function isDomainClaimedElsewhere(
	domain: string,
	organizationId: string,
) {
	const [row] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(
			and(
				eq(Organization.verifiedDomain, domain),
				ne(Organization.id, organizationId),
			),
		)
		.limit(1)
	return Boolean(row)
}

/** Starts a claim: stores the domain and a fresh token until DNS proves it. */
export async function startDomainClaim(organizationId: string, domain: string) {
	const token = newDomainVerificationToken()
	await db
		.update(Organization)
		.set({ pendingVerifiedDomain: domain, verifiedDomainToken: token })
		.where(eq(Organization.id, organizationId))
	return {
		recordName: domainVerificationRecordName(domain),
		recordValue: domainVerificationRecordValue(token),
	}
}

export type DomainCheckResult =
	| { status: 'verified'; domain: string }
	| { status: 'no_claim' }
	| { status: 'not_found'; recordName: string; recordValue: string }
	| { status: 'taken' }
	| { status: 'lookup_failed' }

/** Checks the pending claim's TXT record and, if present, verifies it. */
export async function checkDomainClaim(
	organizationId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<DomainCheckResult> {
	const [org] = await db
		.select({
			pending: Organization.pendingVerifiedDomain,
			token: Organization.verifiedDomainToken,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!org?.pending || !org.token) return { status: 'no_claim' }

	const recordName = domainVerificationRecordName(org.pending)
	const recordValue = domainVerificationRecordValue(org.token)
	let records: string[]
	try {
		records = await lookupTxtRecords(recordName, fetchImpl)
	} catch {
		return { status: 'lookup_failed' }
	}
	if (!records.some((record) => record.trim() === recordValue)) {
		return { status: 'not_found', recordName, recordValue }
	}
	if (await isDomainClaimedElsewhere(org.pending, organizationId)) {
		return { status: 'taken' }
	}
	try {
		await db
			.update(Organization)
			.set({
				verifiedDomain: org.pending,
				verifiedDomainProvedAt: new Date(),
				pendingVerifiedDomain: null,
				verifiedDomainToken: null,
			})
			.where(eq(Organization.id, organizationId))
	} catch {
		// The unique index: another organization verified it first.
		return { status: 'taken' }
	}
	return { status: 'verified', domain: org.pending }
}

/**
 * Invites people already signed up with an address on `domain` who are not
 * members and have no invitation yet. Returns how many were invited and how
 * many were left for later because of the per-verification cap.
 */
export async function inviteExistingDomainUsers({
	organizationId,
	organizationName,
	domain,
	inviterId,
	inviterName,
	request,
}: {
	organizationId: string
	organizationName: string
	domain: string
	inviterId: string
	inviterName: string
	request?: Request
}) {
	const candidates = await db
		.select({ email: User.email })
		.from(User)
		.leftJoin(
			UserOrganization,
			and(
				eq(UserOrganization.userId, User.id),
				eq(UserOrganization.organizationId, organizationId),
			),
		)
		.leftJoin(
			OrganizationInvitation,
			and(
				eq(OrganizationInvitation.email, User.email),
				eq(OrganizationInvitation.organizationId, organizationId),
			),
		)
		.where(
			and(
				like(User.email, `%@${domain}`),
				isNull(UserOrganization.userId),
				isNull(OrganizationInvitation.id),
			),
		)
		.limit(MAX_DOMAIN_INVITES + 1)

	const batch = candidates
		.filter((row) => row.email.toLowerCase().endsWith(`@${domain}`))
		.slice(0, MAX_DOMAIN_INVITES)
	let invited = 0
	for (const { email } of batch) {
		const { invitation } = await createOrganizationInvitation({
			organizationId,
			email,
			inviterId,
			request,
		})
		try {
			await sendOrganizationInvitationEmail({
				invitation,
				organizationName,
				inviterName,
			})
		} catch (error) {
			console.error(
				'Domain invitation email failed:',
				error instanceof Error ? error.message : error,
			)
		}
		invited++
	}
	return { invited, more: candidates.length > MAX_DOMAIN_INVITES }
}
