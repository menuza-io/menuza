import { AuditAction, auditService } from '@repo/audit'
import { isImpersonating } from '@repo/auth'
import {
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	isNull,
	LegalAcceptance,
	LegalAgreement,
	OrganizationRole,
	User,
	UserOrganization,
} from '@repo/database'
import { getClientIp } from '@repo/security'
import { ENV } from 'varlock/env'

/**
 * Menuza's own agreements with restaurants (#194, and the operator side of
 * #89): numbered versions of Terms, Privacy, Data processing, Payment terms
 * and Text marketing terms, and an append-only record of which owner accepted
 * which version for which organization, and when. One system: guest-facing
 * terms on restaurant sites are separate (`utils/legal`, generated pages).
 *
 * Owners are the members whose role is the built-in admin role. Only an owner
 * can accept, never while a support person is impersonating them, and a
 * version marked "required by" blocks the dashboard for owners once its date
 * has passed (until then the dialog can be postponed).
 */

export const AGREEMENT_KEYS = [
	'terms',
	'privacy',
	'dpa',
	'payments',
	'text_marketing',
] as const
export type AgreementKey = (typeof AGREEMENT_KEYS)[number]

/** Modules that ask for their own agreement the first time they are turned on. */
export type AgreementModule = 'payments' | 'text_marketing'

export type AgreementVersion = {
	key: string
	version: number
	/** Locale-keyed JSON (`{"en": "...", "ar": "..."}`). */
	title: string
	url: string
	summary: string | null
	scope: string
	publishedAt: Date
	requiredBy: Date | null
}

export type PendingAgreement = {
	key: string
	version: number
	title: string
	url: string
	summary: string | null
	scope: string
	requiredBy: string | null
	/** Its "required by" date has passed: the dashboard is blocked for owners. */
	overdue: boolean
}

/** The newest published version of every agreement. */
export async function latestAgreements(): Promise<AgreementVersion[]> {
	const rows = await db
		.select()
		.from(LegalAgreement)
		.orderBy(asc(LegalAgreement.key), desc(LegalAgreement.version))
	const seen = new Set<string>()
	const latest: AgreementVersion[] = []
	for (const row of rows) {
		if (seen.has(row.key)) continue
		seen.add(row.key)
		latest.push(row)
	}
	return latest
}

/** Whether the person is an owner (built-in admin role) of the organization. */
export async function isOrganizationOwner(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ name: OrganizationRole.name })
		.from(UserOrganization)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationRole.id, UserOrganization.organizationRoleId),
		)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
				eq(OrganizationRole.name, 'admin'),
				isNull(OrganizationRole.organizationId),
			),
		)
		.limit(1)
	return Boolean(row)
}

/** The versions an organization has accepted, newest per agreement. */
export async function acceptedVersions(
	organizationId: string,
): Promise<Map<string, number>> {
	const rows = await db
		.select({
			key: LegalAcceptance.agreementKey,
			version: LegalAcceptance.version,
		})
		.from(LegalAcceptance)
		.where(eq(LegalAcceptance.organizationId, organizationId))
	const accepted = new Map<string, number>()
	for (const row of rows) {
		accepted.set(row.key, Math.max(accepted.get(row.key) ?? 0, row.version))
	}
	return accepted
}

function toPending(agreement: AgreementVersion, now: Date): PendingAgreement {
	return {
		key: agreement.key,
		version: agreement.version,
		title: agreement.title,
		url: agreement.url,
		summary: agreement.summary,
		scope: agreement.scope,
		requiredBy: agreement.requiredBy?.toISOString() ?? null,
		overdue:
			agreement.requiredBy !== null &&
			agreement.requiredBy.getTime() <= now.getTime(),
	}
}

/**
 * The agreements an organization still has to accept: the newest version of
 * every agreement that applies to everyone (`always`), when the organization
 * has not accepted that version. Module agreements (payments, text marketing)
 * are not listed here: they are asked when the module is turned on
 * (`requireModuleAgreement`), unless a newer version of one the organization
 * already accepted has been published, which is then asked like any other.
 */
export async function pendingAgreementsFor(
	organizationId: string,
	now = new Date(),
): Promise<PendingAgreement[]> {
	const [latest, accepted] = await Promise.all([
		latestAgreements(),
		acceptedVersions(organizationId),
	])
	return latest
		.filter((agreement) => {
			const have = accepted.get(agreement.key) ?? 0
			if (have >= agreement.version) return false
			return agreement.scope === 'always' || have > 0
		})
		.map((agreement) => toPending(agreement, now))
}

/**
 * What the app shell shows a signed-in person: the pending agreements (owners
 * only; other members are never asked), whether the dashboard is blocked, and
 * whether this session may accept (not while impersonating).
 */
export async function agreementPromptFor(input: {
	request: Request
	userId: string
	organizationId: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	if (!(await isOrganizationOwner(input.userId, input.organizationId))) {
		return { pending: [], blocking: false, canAccept: false }
	}
	const pending = await pendingAgreementsFor(input.organizationId, now)
	const impersonating = await isImpersonating(input.request)
	return {
		pending,
		// Support staff must still be able to look at the dashboard.
		blocking: !impersonating && pending.some((agreement) => agreement.overdue),
		canAccept: !impersonating,
	}
}

/** An HMAC of the address, never the address itself. */
export async function hashIpAddress(
	request: Request | undefined,
): Promise<string | null> {
	const secret = ENV.SESSION_SECRET
	if (!secret || !request) return null
	const ip = getClientIp(request, { returnUndefined: true })
	if (!ip) return null
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(`legal-acceptance:${secret}`),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const digest = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(ip),
	)
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

export type AcceptResult =
	| { ok: true; accepted: Array<{ key: string; version: number }> }
	| {
			ok: false
			error:
				| 'impersonating'
				| 'not_owner'
				| 'nothing_to_accept'
				| 'unknown_agreement'
				| 'superseded'
	  }

/**
 * Records that an owner accepted the newest version of each named agreement,
 * with the time and an IP hash. Refused while impersonating, for a member who
 * is not an owner, and for a version that is no longer the newest (the dialog
 * reloads and shows the new one). Accepting twice records once.
 */
export async function acceptAgreements(input: {
	request: Request
	userId: string
	organizationId: string
	items: Array<{ key: string; version: number }>
	source?: 'dialog' | 'module'
	now?: Date
}): Promise<AcceptResult> {
	if (await isImpersonating(input.request)) {
		return { ok: false, error: 'impersonating' }
	}
	if (!(await isOrganizationOwner(input.userId, input.organizationId))) {
		return { ok: false, error: 'not_owner' }
	}
	if (input.items.length === 0) return { ok: false, error: 'nothing_to_accept' }
	const latest = new Map(
		(await latestAgreements()).map((agreement) => [agreement.key, agreement]),
	)
	for (const item of input.items) {
		const current = latest.get(item.key)
		if (!current) return { ok: false, error: 'unknown_agreement' }
		if (current.version !== item.version) {
			return { ok: false, error: 'superseded' }
		}
	}
	const ipHash = await hashIpAddress(input.request)
	const acceptedAt = input.now ?? new Date()
	await db
		.insert(LegalAcceptance)
		.values(
			input.items.map((item) => ({
				agreementKey: item.key,
				version: item.version,
				organizationId: input.organizationId,
				userId: input.userId,
				acceptedAt,
				ipHash,
				source: input.source ?? 'dialog',
			})),
		)
		.onConflictDoNothing()
	await logAcceptance({
		request: input.request,
		userId: input.userId,
		organizationId: input.organizationId,
		items: input.items,
	})
	return { ok: true, accepted: input.items }
}

async function logAcceptance(input: {
	request: Request
	userId: string
	organizationId: string
	items: Array<{ key: string; version: number }>
}) {
	try {
		await auditService.log({
			action: AuditAction.LEGAL_AGREEMENT_ACCEPTED,
			userId: input.userId,
			organizationId: input.organizationId,
			details: `Accepted ${input.items.map((item) => `${item.key} v${item.version}`).join(', ')}.`,
			resourceType: 'legal_agreement',
			resourceId: input.organizationId,
			metadata: { agreements: input.items },
			request: input.request,
		})
	} catch (error) {
		console.error('agreement audit log failed', {
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

/**
 * A module with its own terms (online payments, text marketing) asks for that
 * agreement before it is turned on. Returns the agreement still to accept, or
 * null when the organization already accepted its newest version (or there is
 * none).
 */
export async function requireModuleAgreement(
	organizationId: string,
	module: AgreementModule,
	now = new Date(),
): Promise<PendingAgreement | null> {
	const [latest] = await db
		.select()
		.from(LegalAgreement)
		.where(eq(LegalAgreement.key, module))
		.orderBy(desc(LegalAgreement.version))
		.limit(1)
	if (!latest) return null
	const accepted = await acceptedVersions(organizationId)
	if ((accepted.get(module) ?? 0) >= latest.version) return null
	return toPending(latest, now)
}

/**
 * Sign-up (#194): the person ticked the Terms and Privacy checkbox, so the
 * newest versions of those two are recorded for them. No organization exists
 * yet; `copySignupAcceptances` carries them over to the first one.
 */
export async function recordSignupAcceptance(input: {
	request?: Request
	userId: string
	now?: Date
}) {
	const latest = (await latestAgreements()).filter(
		(agreement) => agreement.key === 'terms' || agreement.key === 'privacy',
	)
	if (latest.length === 0) return []
	const ipHash = await hashIpAddress(input.request)
	await db
		.insert(LegalAcceptance)
		.values(
			latest.map((agreement) => ({
				agreementKey: agreement.key,
				version: agreement.version,
				organizationId: null,
				userId: input.userId,
				acceptedAt: input.now ?? new Date(),
				ipHash,
				source: 'signup',
			})),
		)
		.onConflictDoNothing()
	return latest.map((agreement) => ({
		key: agreement.key,
		version: agreement.version,
	}))
}

/**
 * A new organization starts with what its creator accepted at sign-up: the
 * versions they accepted are recorded for the organization too. An older
 * account with no sign-up record gets none, so its owner is asked.
 */
export async function copySignupAcceptances(input: {
	userId: string
	organizationId: string
}) {
	const rows = await db
		.select()
		.from(LegalAcceptance)
		.where(
			and(
				eq(LegalAcceptance.userId, input.userId),
				isNull(LegalAcceptance.organizationId),
			),
		)
	if (rows.length === 0) return 0
	await db
		.insert(LegalAcceptance)
		.values(
			rows.map((row) => ({
				agreementKey: row.agreementKey,
				version: row.version,
				organizationId: input.organizationId,
				userId: input.userId,
				acceptedAt: row.acceptedAt,
				ipHash: row.ipHash,
				source: 'signup',
			})),
		)
		.onConflictDoNothing()
	return rows.length
}

/** Settings, Legal: what the organization accepted, with who and when. */
export async function listAcceptances(organizationId: string) {
	const rows = await db
		.select({
			id: LegalAcceptance.id,
			key: LegalAcceptance.agreementKey,
			version: LegalAcceptance.version,
			acceptedAt: LegalAcceptance.acceptedAt,
			source: LegalAcceptance.source,
			userId: LegalAcceptance.userId,
		})
		.from(LegalAcceptance)
		.where(eq(LegalAcceptance.organizationId, organizationId))
		.orderBy(desc(LegalAcceptance.acceptedAt))
	const userIds = [
		...new Set(
			rows.map((row) => row.userId).filter((id): id is string => !!id),
		),
	]
	const users = userIds.length
		? await db
				.select({ id: User.id, name: User.name, username: User.username })
				.from(User)
				.where(inArray(User.id, userIds))
		: []
	const nameOf = new Map(
		users.map((user) => [user.id, user.name || user.username]),
	)
	return rows.map((row) => ({
		id: row.id,
		key: row.key,
		version: row.version,
		acceptedAt: row.acceptedAt.toISOString(),
		source: row.source,
		acceptedBy: row.userId ? (nameOf.get(row.userId) ?? null) : null,
	}))
}
