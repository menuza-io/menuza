import {
	parseSiteThemeConfig,
	serializeSiteThemeConfig,
} from '@repo/common/site-theme'
import { and, db, eq, isNull, Organization, sql } from '@repo/database'
import { type SQL } from 'drizzle-orm'
import { canonicalJson } from './versions.ts'

type SiteTheme = ReturnType<typeof parseSiteThemeConfig>

/** Another save kept changing the theme while this one retried. */
export class SiteThemeConflictError extends Error {
	constructor() {
		super('The site theme changed while it was being saved. Try again.')
		this.name = 'SiteThemeConflictError'
	}
}

const MAX_ATTEMPTS = 5

/**
 * Read-modify-write of `Organization.siteTheme` that cannot lose a concurrent
 * save: the UPDATE only applies while the column still holds what was read,
 * and otherwise the change is applied again to the newer value. `db.transaction`
 * runs without a transaction on D1, so this is what keeps two saves (a theme
 * save and a font upload, say) from overwriting each other.
 *
 * `alongside` builds writes that must commit together with the theme (in one
 * `db.batch`). They receive a condition that holds only while the theme is
 * unchanged; add it to their WHERE so nothing applies on a conflict.
 */
export async function updateSiteTheme(
	organizationId: string,
	change: (current: SiteTheme) => SiteTheme,
	alongside?: (
		themeUnchanged: SQL,
	) => Promise<Parameters<typeof db.batch>[0][number][]>,
) {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const [org] = await db
			.select({ siteTheme: Organization.siteTheme })
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1)
		if (!org) throw new Error('Organization not found')
		const previous = org.siteTheme
		const next = serializeSiteThemeConfig(
			change(parseSiteThemeConfig(previous)),
		)

		const sameTheme =
			previous === null
				? isNull(Organization.siteTheme)
				: eq(Organization.siteTheme, previous)
		const themeUnchanged =
			previous === null
				? sql`EXISTS (SELECT 1 FROM ${Organization} WHERE ${Organization.id} = ${organizationId} AND ${Organization.siteTheme} IS NULL)`
				: sql`EXISTS (SELECT 1 FROM ${Organization} WHERE ${Organization.id} = ${organizationId} AND ${Organization.siteTheme} = ${previous})`
		// Other writes run first so their condition still sees the old theme.
		const others = alongside ? await alongside(themeUnchanged) : []
		const themeUpdate = db
			.update(Organization)
			.set({ siteTheme: next })
			.where(and(eq(Organization.id, organizationId), sameTheme))
			.returning({ id: Organization.id })
		const results = await db.batch([...others, themeUpdate] as unknown as [
			typeof themeUpdate,
		])
		const updated = results[results.length - 1] as unknown as { id: string }[]
		if (updated.length > 0) return
	}
	throw new SiteThemeConflictError()
}

/**
 * Like `updateSiteTheme`, but writes the unpublished theme (#85): the change
 * applies to the draft when there is one and to live otherwise, and lands in
 * `Organization.draftSiteTheme`. The public site keeps reading `siteTheme`
 * until a publish. A result equal to live clears the draft. The write only
 * applies while both columns still hold what was read, and is otherwise tried
 * again on the newer values.
 */
export async function updateSiteThemeDraft(
	organizationId: string,
	change: (current: SiteTheme) => SiteTheme,
) {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const [org] = await db
			.select({
				siteTheme: Organization.siteTheme,
				draftSiteTheme: Organization.draftSiteTheme,
			})
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1)
		if (!org) throw new Error('Organization not found')
		const next = serializeSiteThemeConfig(
			change(parseSiteThemeConfig(org.draftSiteTheme ?? org.siteTheme)),
		)
		const liveNormalized = serializeSiteThemeConfig(
			parseSiteThemeConfig(org.siteTheme),
		)
		const draft =
			canonicalJson(next) === canonicalJson(liveNormalized) ? null : next
		const updated = await db
			.update(Organization)
			.set({ draftSiteTheme: draft })
			.where(
				and(
					eq(Organization.id, organizationId),
					sql`${Organization.siteTheme} IS ${org.siteTheme}`,
					sql`${Organization.draftSiteTheme} IS ${org.draftSiteTheme}`,
				),
			)
			.returning({ id: Organization.id })
		if (updated.length > 0) return
	}
	throw new SiteThemeConflictError()
}
