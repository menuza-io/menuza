import { db, eq, Organization } from '@repo/database'
import { canonicalJson } from './versions.ts'

/**
 * Header, footer and theme are site-wide, so their edits are drafts (#85):
 * `Organization.draftHeaderConfig`, `draftFooterConfig` and `draftSiteTheme`
 * hold what the editor shows, `null` meaning "same as live". The public site
 * reads only `siteHeaderConfig`, `siteFooterConfig` and `siteTheme`, which
 * change only through a publish (`publish-page.server.ts`) or a restore +
 * publish. Edits that end up equal to live clear the draft.
 */
export async function saveChromeDraft(
	organizationId: string,
	patch: { header?: string; footer?: string },
) {
	const [org] = await db
		.select({
			siteHeaderConfig: Organization.siteHeaderConfig,
			siteFooterConfig: Organization.siteFooterConfig,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!org) throw new Error('Organization not found')
	const draftFor = (next: string, live: string | null) =>
		canonicalJson(next) === canonicalJson(live) ? null : next
	const set: {
		draftHeaderConfig?: string | null
		draftFooterConfig?: string | null
	} = {}
	if (patch.header !== undefined) {
		set.draftHeaderConfig = draftFor(patch.header, org.siteHeaderConfig)
	}
	if (patch.footer !== undefined) {
		set.draftFooterConfig = draftFor(patch.footer, org.siteFooterConfig)
	}
	if (Object.keys(set).length === 0) return
	await db
		.update(Organization)
		.set(set)
		.where(eq(Organization.id, organizationId))
}

/** Drops every unpublished header, footer and theme edit: the editor shows live again. */
export async function discardSiteDesignDraft(organizationId: string) {
	await db
		.update(Organization)
		.set({
			draftHeaderConfig: null,
			draftFooterConfig: null,
			draftSiteTheme: null,
		})
		.where(eq(Organization.id, organizationId))
}

/** The header, footer and theme the editor shows: the draft, else live. */
export async function readSiteDesign(organizationId: string) {
	const [org] = await db
		.select({
			siteHeaderConfig: Organization.siteHeaderConfig,
			siteFooterConfig: Organization.siteFooterConfig,
			siteTheme: Organization.siteTheme,
			draftHeaderConfig: Organization.draftHeaderConfig,
			draftFooterConfig: Organization.draftFooterConfig,
			draftSiteTheme: Organization.draftSiteTheme,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!org) throw new Error('Organization not found')
	return {
		...org,
		header: org.draftHeaderConfig ?? org.siteHeaderConfig,
		footer: org.draftFooterConfig ?? org.siteFooterConfig,
		theme: org.draftSiteTheme ?? org.siteTheme,
	}
}
