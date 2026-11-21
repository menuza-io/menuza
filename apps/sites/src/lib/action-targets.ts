import {
	actionForPath,
	actionReplacedEverywhere,
	EMPTY_ACTION_TARGETS,
	pageIsReplaced,
	resolveActionHref,
	type ActionLink,
	type PublicActionTargets,
} from '@repo/common/action-targets'
import { type ActionKind } from '@repo/common/action-targets'
import { resolveSiteLink, type SiteLinkInput } from '@repo/common/site-link'

/**
 * Where the site's Order online, Gift cards and Reservations buttons go
 * (#318), as Sites uses it. ONE resolver: every button and link (header,
 * hero, sections, footer, location, delivery and dish pages), the structured
 * data and the sitemap read the organization's `actionTargets` through the
 * functions here, so one switch changes them all and switching back restores
 * them. The setting is checked by the App when it is saved and again when it
 * is read.
 */

type OrganizationLike =
	| {
			actionTargets?: PublicActionTargets | null
			locales?: string[]
	  }
	| null
	| undefined

export function targetsOf(organization: OrganizationLike): PublicActionTargets {
	return organization?.actionTargets ?? EMPTY_ACTION_TARGETS
}

/** The link a button to `href` should use: another site's, or the same one. */
export function actionLink(
	organization: OrganizationLike,
	href: string,
	options: { locationId?: string | null } = {},
): ActionLink {
	return resolveActionHref(href, targetsOf(organization), {
		locales: organization?.locales,
		locationId: options.locationId,
	})
}

/** Anchor attributes for a resolved link (`target`, `rel`, the outbound mark). */
export function actionAttrs(link: ActionLink) {
	return link.external
		? {
				target: link.target,
				rel: link.rel,
				'data-outbound': link.kind ?? undefined,
			}
		: {}
}

/**
 * A navigation entry that leads to one of our own pages for an action that
 * goes to another site everywhere: it is left out of the menu, not shown as a
 * dead end. (The buttons for that action open the other site instead.)
 */
export function navLinkIsReplaced(
	organization: OrganizationLike,
	link: SiteLinkInput,
) {
	const targets = targetsOf(organization)
	const { href } = resolveSiteLink(link)
	if (!href.startsWith('/')) return false
	let path: string
	try {
		path = new URL(href, 'https://site.invalid').pathname
	} catch {
		return false
	}
	const kind = actionForPath(path, organization?.locales)
	return kind
		? actionReplacedEverywhere(targets, kind, Object.keys(targets.locations))
		: false
}

/** Our own page for an action that goes elsewhere: `noindex`, out of the sitemap. */
export function pageReplaced(organization: OrganizationLike, pathname: string) {
	const targets = targetsOf(organization)
	return pageIsReplaced(pathname, targets, {
		locales: organization?.locales,
		locationIds: Object.keys(targets.locations),
	})
}

/**
 * The address and attributes of a button to one of our own pages: another
 * site's link when the action goes there, else `localize(path)` (the same
 * address with the visitor's language). `locationId` picks that location's own
 * choice for a button that belongs to it.
 */
export function actionAnchor(
	organization: OrganizationLike,
	path: string,
	localize: (path: string) => string,
	options: { locationId?: string | null } = {},
) {
	const link = actionLink(organization, path, options)
	return {
		href: link.external ? link.href : localize(path),
		attrs: actionAttrs(link),
		external: link.external,
	}
}

/** Whether the organization or any location sends this action to another site. */
export function externalFor(organization: OrganizationLike, kind: ActionKind) {
	const targets = targetsOf(organization)
	return (
		targets.organization[kind]?.mode === 'external' ||
		Object.values(targets.locations).some(
			(location) => location[kind]?.mode === 'external',
		)
	)
}
