import {
	ACTION_KINDS,
	linkIsOwnDomain,
	parseActionTargets,
	serializeActionTargets,
	validateActionUrl,
	type ActionKind,
	type ActionTargets,
	type ActionUrlError,
	type PublicActionTargets,
} from '@repo/common/action-targets'
import {
	and,
	db,
	eq,
	isNotNull,
	Organization,
	OrganizationLocation,
	SiteDomain,
} from '@repo/database'
import { ENV } from 'varlock/env'
import { resolveSitesOrigin } from '#app/utils/sites/sites-origin.server.ts'

/**
 * Where the site's Order online, Gift cards and Reservations buttons go
 * (#318). Stored as JSON on the organization and, where the brand has several
 * locations, on each location (control plane, business data only). Saving
 * checks every link: https, and never one of the site's own domains.
 */

/** Every host the site answers on: the default address, custom domains and www. */
export async function ownSiteHosts(organizationId: string) {
	const [organization] = await db
		.select({
			slug: Organization.slug,
			customDomain: Organization.customDomain,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!organization) return []
	const hosts = new Set<string>()
	const addOrigin = (origin: string) => {
		try {
			hosts.add(new URL(origin).hostname.toLowerCase())
		} catch {
			// not an address
		}
	}
	addOrigin(
		resolveSitesOrigin({
			slug: organization.slug,
			customDomain: null,
			baseUrl: ENV.BASE_URL ?? '',
			hostSuffixes: (ENV as { PUBLIC_SITE_HOST_SUFFIXES?: string })
				.PUBLIC_SITE_HOST_SUFFIXES,
		}),
	)
	if (organization.customDomain)
		hosts.add(organization.customDomain.toLowerCase())
	const domains = await db
		.select({ hostname: SiteDomain.hostname })
		.from(SiteDomain)
		.where(eq(SiteDomain.organizationId, organizationId))
	for (const row of domains) hosts.add(row.hostname.toLowerCase())
	return [...hosts]
}

export type ActionTargetsForm = Partial<
	Record<ActionKind, { mode: 'menuza' | 'external' | 'inherit'; url?: string }>
>

export type SaveActionTargetsResult =
	| { ok: true; targets: ActionTargets }
	| {
			ok: false
			error: ActionUrlError | 'not_found' | 'invalid_request'
			kind?: ActionKind
	  }

/**
 * Saves the choice for the organization (`locationId` null) or one location.
 * `inherit` (locations only) drops the location's own choice. Nothing is saved
 * unless every link checks out.
 */
export async function saveActionTargets(input: {
	organizationId: string
	locationId: string | null
	form: ActionTargetsForm
}): Promise<SaveActionTargetsResult> {
	let location: { actionTargets: string | null } | undefined
	if (input.locationId) {
		;[location] = await db
			.select({ actionTargets: OrganizationLocation.actionTargets })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, input.locationId),
					eq(OrganizationLocation.organizationId, input.organizationId),
				),
			)
			.limit(1)
		if (!location) return { ok: false, error: 'not_found' }
	}
	const ownHosts = await ownSiteHosts(input.organizationId)
	const next: ActionTargets = {}
	for (const kind of ACTION_KINDS) {
		const choice = input.form[kind]
		if (!choice) continue
		if (choice.mode === 'menuza') next[kind] = { mode: 'menuza' }
		else if (choice.mode === 'external') {
			const checked = validateActionUrl(choice.url, ownHosts)
			if (!checked.ok) return { ok: false, error: checked.error, kind }
			next[kind] = { mode: 'external', url: checked.url }
		} else if (choice.mode === 'inherit' && !input.locationId) {
			return { ok: false, error: 'invalid_request', kind }
		}
		// `inherit` on a location: the kind stays out of its own setting.
	}
	const serialized = serializeActionTargets(next)
	if (input.locationId) {
		await db
			.update(OrganizationLocation)
			.set({ actionTargets: serialized })
			.where(eq(OrganizationLocation.id, input.locationId))
	} else {
		await db
			.update(Organization)
			.set({ actionTargets: serialized })
			.where(eq(Organization.id, input.organizationId))
	}
	return { ok: true, targets: next }
}

/** The organization's and each location's settings, for the editor and Sites. */
/**
 * A setting that sends visitors to one of the site's own domains (one added
 * after the link was saved) would loop: it is left out, which means Menuza.
 */
function withoutOwnDomains(
	targets: ActionTargets,
	ownHosts: readonly string[],
): ActionTargets {
	const out: ActionTargets = {}
	for (const kind of ACTION_KINDS) {
		const target = targets[kind]
		if (!target) continue
		if (target.mode === 'external' && linkIsOwnDomain(target.url, ownHosts)) {
			continue
		}
		out[kind] = target
	}
	return out
}

export async function loadPublicActionTargets(
	organizationId: string,
	organizationActionTargets?: string | null,
	options: { dropOwnDomains?: boolean } = {},
): Promise<PublicActionTargets> {
	const organization =
		organizationActionTargets !== undefined
			? organizationActionTargets
			: (
					await db
						.select({ actionTargets: Organization.actionTargets })
						.from(Organization)
						.where(eq(Organization.id, organizationId))
						.limit(1)
				)[0]?.actionTargets
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			actionTargets: OrganizationLocation.actionTargets,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				isNotNull(OrganizationLocation.actionTargets),
			),
		)
	const ownHosts = options.dropOwnDomains
		? await ownSiteHosts(organizationId)
		: null
	const read = (raw: string | null | undefined) => {
		const parsed = parseActionTargets(raw)
		return ownHosts ? withoutOwnDomains(parsed, ownHosts) : parsed
	}
	const locations: Record<string, ActionTargets> = {}
	for (const row of rows) {
		const parsed = read(row.actionTargets)
		if (Object.keys(parsed).length) locations[row.id] = parsed
	}
	return { organization: read(organization), locations }
}
