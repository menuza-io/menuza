import { AuditAction, auditService } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import {
	customFontsOf,
	removeCustomFontFromThemeJson,
} from '@repo/common/font-licence'
import {
	and,
	db,
	desc,
	eq,
	isNull,
	like,
	or,
	FontLicenceAcceptance,
	Organization,
	User,
} from '@repo/database'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requestSiteCachePurge } from '#app/utils/sites-cache-purge.server.ts'

/**
 * Admin, Font licences (#286): who confirmed a web licence for which custom
 * font, per organization, and removing a font after a complaint. The
 * acceptance rows are written by the App when a member uploads; Admin reads
 * them and can take a font down. Taking it down clears it from the live and
 * the draft theme, so the site falls back to the theme font at once (fonts are
 * loaded by reference, nothing is republished).
 */

const LIMIT = 200

export async function listFontAcceptances(input: {
	search?: string
	limit?: number
}) {
	const term = input.search?.trim().slice(0, 100)
	const rows = await db
		.select({
			id: FontLicenceAcceptance.id,
			organizationId: FontLicenceAcceptance.organizationId,
			organizationName: Organization.name,
			organizationSlug: Organization.slug,
			siteTheme: Organization.siteTheme,
			draftSiteTheme: Organization.draftSiteTheme,
			userId: FontLicenceAcceptance.userId,
			memberName: User.name,
			memberUsername: User.username,
			role: FontLicenceAcceptance.role,
			fileName: FontLicenceAcceptance.fileName,
			fileHash: FontLicenceAcceptance.fileHash,
			objectKey: FontLicenceAcceptance.objectKey,
			agreementVersion: FontLicenceAcceptance.agreementVersion,
			acceptedAt: FontLicenceAcceptance.acceptedAt,
			removedAt: FontLicenceAcceptance.removedAt,
			removedBy: FontLicenceAcceptance.removedBy,
			removedReason: FontLicenceAcceptance.removedReason,
		})
		.from(FontLicenceAcceptance)
		.innerJoin(
			Organization,
			eq(Organization.id, FontLicenceAcceptance.organizationId),
		)
		.leftJoin(User, eq(User.id, FontLicenceAcceptance.userId))
		.where(
			term
				? or(
						like(Organization.name, `%${term}%`),
						like(Organization.slug, `%${term}%`),
						like(FontLicenceAcceptance.fileName, `%${term}%`),
					)
				: undefined,
		)
		.orderBy(desc(FontLicenceAcceptance.acceptedAt))
		.limit(Math.min(input.limit ?? LIMIT, LIMIT))
	return rows.map((row) => {
		const inUse = new Set([
			...customFontsOf(row.siteTheme).map((font) => font.objectKey),
			...customFontsOf(row.draftSiteTheme).map((font) => font.objectKey),
		])
		return {
			id: row.id,
			organization: {
				id: row.organizationId,
				name: row.organizationName,
				slug: row.organizationSlug,
			},
			member: row.memberName || row.memberUsername || row.userId,
			role: row.role,
			fileName: row.fileName,
			fileHash: row.fileHash,
			agreementVersion: row.agreementVersion,
			acceptedAt: row.acceptedAt.toISOString(),
			removedAt: row.removedAt?.toISOString() ?? null,
			removedBy: row.removedBy,
			removedReason: row.removedReason,
			/** The site still loads this file. */
			inUse: row.removedAt === null && inUse.has(row.objectKey),
		}
	})
}

const RemoveSchema = z.object({
	_action: z.literal('remove-font'),
	acceptanceId: z.string().min(1).max(64),
	reason: z.string().trim().max(500).optional(),
})

async function clearThemeFont(
	organizationId: string,
	objectKey: string,
	column: 'siteTheme' | 'draftSiteTheme',
) {
	const [org] = await db
		.select({ theme: Organization[column] })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!org?.theme) return false
	const roles = customFontsOf(org.theme)
		.filter((font) => font.objectKey === objectKey)
		.map((font) => font.role)
	if (roles.length === 0) return false
	const { json } = removeCustomFontFromThemeJson(org.theme, roles)
	await db
		.update(Organization)
		.set({ [column]: json })
		.where(
			and(
				eq(Organization.id, organizationId),
				eq(Organization[column], org.theme),
			),
		)
	return true
}

/**
 * Takes the font of one acceptance off the site (live and draft) and marks
 * every acceptance of that file removed. When the organization already
 * replaced the font, only the record changes: the new file is not touched.
 */
export async function removeFontAsAdmin(input: {
	adminUserId: string
	acceptanceId: string
	reason?: string
	request?: Request
}) {
	const [acceptance] = await db
		.select()
		.from(FontLicenceAcceptance)
		.where(eq(FontLicenceAcceptance.id, input.acceptanceId))
		.limit(1)
	if (!acceptance) return { ok: false as const, error: 'not_found' as const }
	// Live first: a request between the two writes must never read the font.
	const live = await clearThemeFont(
		acceptance.organizationId,
		acceptance.objectKey,
		'siteTheme',
	)
	const draft = await clearThemeFont(
		acceptance.organizationId,
		acceptance.objectKey,
		'draftSiteTheme',
	)
	await db
		.update(FontLicenceAcceptance)
		.set({
			removedAt: new Date(),
			removedBy: 'admin',
			removedByUserId: input.adminUserId,
			removedReason: input.reason ?? null,
		})
		.where(
			and(
				eq(FontLicenceAcceptance.organizationId, acceptance.organizationId),
				eq(FontLicenceAcceptance.objectKey, acceptance.objectKey),
				isNull(FontLicenceAcceptance.removedAt),
			),
		)
	requestSiteCachePurge({ organizationId: acceptance.organizationId })
	try {
		await auditService.log({
			action: AuditAction.FONT_REMOVED,
			userId: input.adminUserId,
			details: `Removed custom font ${acceptance.fileName} from an organization's site.`,
			resourceType: 'font_licence',
			resourceId: acceptance.id,
			metadata: {
				organizationId: acceptance.organizationId,
				role: acceptance.role,
				removedFromLive: live,
				removedFromDraft: draft,
				reason: input.reason ?? null,
			},
			request: input.request,
		})
	} catch {
		// A log line never undoes a removal.
	}
	return { ok: true as const, removedFromLive: live, removedFromDraft: draft }
}

export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const search = new URL(request.url).searchParams.get('search') ?? ''
	return { acceptances: await listFontAcceptances({ search }), search }
}

export async function action({ request }: ActionFunctionArgs) {
	const adminUserId = await requireUserWithRole(request, 'admin')
	const parsed = RemoveSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		return Response.json({ status: 'error', error: 'invalid' }, { status: 400 })
	}
	const result = await removeFontAsAdmin({
		adminUserId,
		acceptanceId: parsed.data.acceptanceId,
		reason: parsed.data.reason,
		request,
	})
	if (!result.ok) {
		return Response.json(
			{ status: 'error', error: result.error },
			{ status: 404 },
		)
	}
	return Response.json({ status: 'success', ...result })
}
