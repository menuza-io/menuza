import { AuditAction, auditService } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import {
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	LegalAcceptance,
	LegalAgreement,
	Organization,
	OrganizationRole,
	User,
	UserOrganization,
} from '@repo/database'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'

/**
 * Admin, Legal agreements (#194): the numbered versions of every Menuza
 * agreement, who has and has not accepted the newest one, and publishing a new
 * version (optionally "required by" a date, after which the dashboard is
 * blocked for owners who have not accepted). The acceptance table is
 * append-only and owned by the App; Admin only reads it.
 */

export const AGREEMENT_KEYS = [
	'terms',
	'privacy',
	'dpa',
	'payments',
	'text_marketing',
] as const

export type AgreementKey = (typeof AGREEMENT_KEYS)[number]

const NEVER_ACCEPTED_LIMIT = 200

/** Newest version per agreement, with how many organizations accepted it. */
export async function loadAgreementOverview() {
	const versions = await db
		.select()
		.from(LegalAgreement)
		.orderBy(asc(LegalAgreement.key), desc(LegalAgreement.version))
	const latest = new Map<string, (typeof versions)[number]>()
	for (const row of versions) if (!latest.has(row.key)) latest.set(row.key, row)
	const organizations = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(eq(Organization.active, true))
	const accepted = await db
		.select({
			key: LegalAcceptance.agreementKey,
			version: LegalAcceptance.version,
			organizationId: LegalAcceptance.organizationId,
		})
		.from(LegalAcceptance)
	const acceptedBy = new Map<string, Set<string>>()
	for (const row of accepted) {
		if (!row.organizationId) continue
		const id = `${row.key}:${row.version}`
		const set = acceptedBy.get(id) ?? new Set<string>()
		set.add(row.organizationId)
		acceptedBy.set(id, set)
	}
	const activeIds = new Set(organizations.map((org) => org.id))
	return [...latest.values()].map((row) => {
		const done = acceptedBy.get(`${row.key}:${row.version}`) ?? new Set()
		const acceptedCount = [...done].filter((id) => activeIds.has(id)).length
		return {
			key: row.key,
			version: row.version,
			title: row.title,
			url: row.url,
			scope: row.scope,
			publishedAt: row.publishedAt.toISOString(),
			requiredBy: row.requiredBy?.toISOString() ?? null,
			acceptedCount,
			organizationCount: organizations.length,
		}
	})
}

/**
 * The active organizations that have not accepted a version (or a newer one
 * of the same agreement), with their owners. Default: the newest version.
 */
export async function listOrganizationsMissing(input: {
	key: string
	version?: number
	now?: Date
}) {
	const [agreement] = await db
		.select()
		.from(LegalAgreement)
		.where(
			input.version
				? and(
						eq(LegalAgreement.key, input.key),
						eq(LegalAgreement.version, input.version),
					)
				: eq(LegalAgreement.key, input.key),
		)
		.orderBy(desc(LegalAgreement.version))
		.limit(1)
	if (!agreement) return null
	const organizations = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
			createdAt: Organization.createdAt,
		})
		.from(Organization)
		.where(eq(Organization.active, true))
		.orderBy(asc(Organization.createdAt))
	const accepted = await db
		.select({
			organizationId: LegalAcceptance.organizationId,
			version: LegalAcceptance.version,
		})
		.from(LegalAcceptance)
		.where(eq(LegalAcceptance.agreementKey, agreement.key))
	const have = new Set<string>()
	for (const row of accepted) {
		if (row.organizationId && row.version >= agreement.version) {
			have.add(row.organizationId)
		}
	}
	const missing = organizations.filter((org) => !have.has(org.id))
	const shown = missing.slice(0, NEVER_ACCEPTED_LIMIT)
	const owners = shown.length
		? await db
				.select({
					organizationId: UserOrganization.organizationId,
					name: User.name,
					username: User.username,
					email: User.email,
				})
				.from(UserOrganization)
				.innerJoin(User, eq(User.id, UserOrganization.userId))
				.innerJoin(
					OrganizationRole,
					eq(OrganizationRole.id, UserOrganization.organizationRoleId),
				)
				.where(
					and(
						inArray(
							UserOrganization.organizationId,
							shown.map((org) => org.id),
						),
						eq(UserOrganization.active, true),
						eq(OrganizationRole.name, 'admin'),
					),
				)
		: []
	const now = input.now ?? new Date()
	return {
		agreement: {
			key: agreement.key,
			version: agreement.version,
			requiredBy: agreement.requiredBy?.toISOString() ?? null,
			overdue:
				agreement.requiredBy !== null &&
				agreement.requiredBy.getTime() <= now.getTime(),
		},
		total: missing.length,
		organizations: shown.map((org) => ({
			id: org.id,
			name: org.name,
			slug: org.slug,
			createdAt: org.createdAt.toISOString(),
			owners: owners
				.filter((owner) => owner.organizationId === org.id)
				.map((owner) => owner.name || owner.username)
				.slice(0, 3),
		})),
	}
}

const PublishSchema = z.object({
	_action: z.literal('publish'),
	key: z.enum(AGREEMENT_KEYS),
	titleEn: z.string().trim().min(1).max(120),
	titleAr: z.string().trim().max(120).optional(),
	summaryEn: z.string().trim().max(1000).optional(),
	summaryAr: z.string().trim().max(1000).optional(),
	url: z
		.string()
		.trim()
		.min(1)
		.max(300)
		.refine(
			(value) => /^\/[^/\\]/u.test(value) || /^https:\/\//iu.test(value),
			{
				message: 'Use a path on the marketing site or an https:// address',
			},
		),
	requiredBy: z
		.string()
		.trim()
		.optional()
		.refine((value) => !value || !Number.isNaN(Date.parse(value)), {
			message: 'Enter a valid date',
		}),
})

function localized(en: string | undefined, ar: string | undefined) {
	const map: Record<string, string> = {}
	if (en) map.en = en
	if (ar) map.ar = ar
	return JSON.stringify(map)
}

/**
 * Publishes the next numbered version of an agreement. Owners are asked at
 * their next sign-in; with `requiredBy` the dashboard is blocked for those who
 * have not accepted once that date has passed.
 */
export async function publishAgreementVersion(
	adminUserId: string,
	input: z.infer<typeof PublishSchema>,
	request?: Request,
) {
	const [current] = await db
		.select({
			version: LegalAgreement.version,
			scope: LegalAgreement.scope,
		})
		.from(LegalAgreement)
		.where(eq(LegalAgreement.key, input.key))
		.orderBy(desc(LegalAgreement.version))
		.limit(1)
	const version = (current?.version ?? 0) + 1
	const scope =
		current?.scope ??
		(input.key === 'payments' || input.key === 'text_marketing'
			? 'module'
			: 'always')
	await db.insert(LegalAgreement).values({
		key: input.key,
		version,
		title: localized(input.titleEn, input.titleAr),
		url: input.url,
		summary:
			input.summaryEn || input.summaryAr
				? localized(input.summaryEn, input.summaryAr)
				: null,
		scope,
		requiredBy: input.requiredBy ? new Date(input.requiredBy) : null,
	})
	try {
		await auditService.log({
			action: AuditAction.LEGAL_AGREEMENT_PUBLISHED,
			userId: adminUserId,
			details: `Published ${input.key} version ${version}.`,
			resourceType: 'legal_agreement',
			resourceId: `${input.key}:${version}`,
			metadata: {
				key: input.key,
				version,
				requiredBy: input.requiredBy ?? null,
			},
			request,
		})
	} catch {
		// A log line never undoes a publish.
	}
	return { key: input.key, version }
}

export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const url = new URL(request.url)
	const key = url.searchParams.get('key')
	const versionParam = Number(url.searchParams.get('version'))
	const overview = await loadAgreementOverview()
	const selected = key
		? await listOrganizationsMissing({
				key,
				version:
					Number.isInteger(versionParam) && versionParam > 0
						? versionParam
						: undefined,
			})
		: null
	return { overview, selected, keys: AGREEMENT_KEYS }
}

export async function action({ request }: ActionFunctionArgs) {
	const adminId = await requireUserWithRole(request, 'admin')
	const form = Object.fromEntries(await request.formData())
	const parsed = PublishSchema.safeParse(form)
	if (!parsed.success) {
		return Response.json(
			{ status: 'error', errors: z.flattenError(parsed.error).fieldErrors },
			{ status: 400 },
		)
	}
	const published = await publishAgreementVersion(adminId, parsed.data, request)
	return Response.json({ status: 'success', ...published })
}
