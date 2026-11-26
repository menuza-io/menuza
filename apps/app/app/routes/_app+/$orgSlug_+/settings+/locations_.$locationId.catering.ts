import { AuditAction, auditService } from '@repo/audit'
import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import {
	cateringSettingsSchema,
	defaultCateringSettings,
	parseCateringSettings,
	validateCateringSettings,
} from '@repo/common/catering'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	and,
	db,
	eq,
	OrganizationLocation,
	User,
	UserOrganization,
} from '@repo/database'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { getCateringFeatures } from '#app/utils/catering/catering-context.server.ts'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Settings, Locations, Catering (#124, #255, #361, #325): turn catering on for
 * a location with its notice, window, limits, quote mode, the members told
 * about new requests, the order-by cutoffs, the deposit and the answers shown
 * on the catering page and given to the phone agent. Viewing needs
 * `read:settings:any`, changing needs `update:settings:any`, and a member
 * limited to some locations cannot touch another's. Business settings only: no
 * guest data lives here. Offered only while the organization has
 * `catering.enabled` on (the answer says `enabled: false` otherwise and nothing
 * is written).
 */
async function authorize(
	request: Request,
	params: LoaderFunctionArgs['params'],
	permission:
		| typeof ORG_PERMISSIONS.READ_SETTINGS_ANY
		| typeof ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		permission,
	)
	const locationId = params.locationId
	if (!locationId) {
		throw new Response('Location ID is required', { status: 400 })
	}
	const scope = await resolveMemberLocationIds(userId, organization.id)
	if (scope !== null && !scope.includes(locationId)) {
		throw new Response('Forbidden', { status: 403 })
	}
	const [location] = await db
		.select({
			id: OrganizationLocation.id,
			timezone: OrganizationLocation.timezone,
			catering: OrganizationLocation.catering,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organization.id),
			),
		)
		.limit(1)
	if (!location) throw new Response('Location not found', { status: 404 })
	return { userId, organization, location }
}

async function view(
	organization: {
		id: string
		siteLocales: string | null
		siteDefaultLocale: string | null
	},
	location: { id: string; timezone: string; catering: string | null },
	canEdit: boolean,
) {
	const features = await getCateringFeatures(organization.id)
	const members = await db
		.select({
			userId: UserOrganization.userId,
			name: User.name,
			email: User.email,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.where(
			and(
				eq(UserOrganization.organizationId, organization.id),
				eq(UserOrganization.active, true),
			),
		)
	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	return {
		enabled: true as const,
		canEdit,
		quotesFlag: features.quotes,
		timeZone: location.timezone,
		locales,
		defaultLocale,
		settings:
			parseCateringSettings(location.catering) ?? defaultCateringSettings(),
		members: members
			.map((member) => ({
				userId: member.userId,
				label: member.name?.trim() || member.email || member.userId,
			}))
			.sort((a, b) => a.label.localeCompare(b.label)),
	}
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { userId, organization, location } = await authorize(
		request,
		params,
		ORG_PERMISSIONS.READ_SETTINGS_ANY,
	)
	const features = await getCateringFeatures(organization.id)
	if (!features.enabled) {
		return Response.json({ enabled: false }, { headers: NO_STORE })
	}
	const canEdit = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	return Response.json(await view(organization, location, canEdit), {
		headers: NO_STORE,
	})
}

const bodySchema = z.object({
	intent: z.literal('save'),
	// The whole settings object as JSON: validated against the shared schema.
	settings: z.string().min(2).max(60_000),
})

function fail(status: number, error: string, issues?: string[]) {
	return Response.json(
		{ ok: false, error, ...(issues ? { issues } : {}) },
		{ status, headers: NO_STORE },
	)
}

export async function action({ request, params }: ActionFunctionArgs) {
	if (request.method !== 'POST') return fail(405, 'method_not_allowed')
	const { userId, organization, location } = await authorize(
		request,
		params,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const features = await getCateringFeatures(organization.id)
	if (!features.enabled) return fail(404, 'not_found')
	const parsedBody = bodySchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsedBody.success) return fail(400, 'invalid_request')
	let raw: unknown
	try {
		raw = JSON.parse(parsedBody.data.settings)
	} catch {
		return fail(400, 'invalid_request')
	}
	const settings = cateringSettingsSchema.safeParse(raw)
	if (!settings.success) {
		return fail(
			400,
			'invalid_settings',
			settings.error.issues.slice(0, 5).map((issue) => issue.message),
		)
	}
	// Alert members must belong to this organization.
	if (settings.data.alertUserIds.length > 0) {
		const members = await db
			.select({ userId: UserOrganization.userId })
			.from(UserOrganization)
			.where(
				and(
					eq(UserOrganization.organizationId, organization.id),
					eq(UserOrganization.active, true),
				),
			)
		const allowed = new Set(members.map((member) => member.userId))
		if (settings.data.alertUserIds.some((id) => !allowed.has(id))) {
			return fail(400, 'invalid_settings')
		}
	}
	const problems = validateCateringSettings(settings.data, {
		timeZone: location.timezone,
		now: new Date(),
		quotesFlag: features.quotes,
	})
	if (problems.length > 0) return fail(400, 'invalid_settings', problems)
	await db
		.update(OrganizationLocation)
		.set({ catering: JSON.stringify(settings.data) })
		.where(
			and(
				eq(OrganizationLocation.id, location.id),
				eq(OrganizationLocation.organizationId, organization.id),
			),
		)
	// The catering page and its answers come from the cached site menu.
	await purgeOrganizationSiteCache(organization.id, organization.slug)
	await auditService.log({
		action: AuditAction.ORG_SETTINGS_UPDATED,
		userId,
		organizationId: organization.id,
		resourceType: 'organization_location',
		resourceId: location.id,
		details: 'Catering settings updated',
		metadata: {
			enabled: settings.data.enabled,
			quoteMode: settings.data.quoteMode,
			cutoffs: settings.data.cutoffs.length,
			depositPercent: settings.data.deposit.percent,
		},
		request,
	})
	const [fresh] = await db
		.select({
			id: OrganizationLocation.id,
			timezone: OrganizationLocation.timezone,
			catering: OrganizationLocation.catering,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.id, location.id))
		.limit(1)
	return Response.json(
		{ ...(await view(organization, fresh ?? location, true)), ok: true },
		{ headers: NO_STORE },
	)
}
