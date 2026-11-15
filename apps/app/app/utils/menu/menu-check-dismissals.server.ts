import { auditService, AuditAction } from '@repo/audit'
import { and, db, eq, MenuCheckDismissal } from '@repo/database'
import { loadMenuHealthWithData } from './menu-health.server.ts'
import {
	menuHealthEntityType,
	parseMenuHealthCheckKey,
	type MenuHealthCheckKey,
} from './menu-health.ts'

/**
 * Menu health dismissals ("No photo on purpose"). One row per organization,
 * record and check key in `MenuCheckDismissal`, with the fingerprint of the
 * field the check reads, computed here and never taken from the browser.
 * The row applies while that fingerprint holds; `loadMenuHealth` drops it
 * once the record passes or the field changes. Review-stack skips share the
 * table under `card:<kind>` keys (see `card-skips.server.ts`).
 *
 * Callers check access first: `requireMenuWrite` (`update:menu:any`).
 */

export const MENU_CHECK_DISMISS_REASONS = ['on_purpose', 'not_applicable'] as const
export type MenuCheckDismissReason = (typeof MENU_CHECK_DISMISS_REASONS)[number]

export class MenuCheckDismissalError extends Error {
	constructor(readonly code: 'not_found' | 'not_failing' | 'invalid_input') {
		super(code)
		this.name = 'MenuCheckDismissalError'
	}
}

type Organization = {
	id: string
	siteLocales: string | null
	siteDefaultLocale: string | null
}

/** Audit only ids and the check key, filed under the record's type. */
function auditTarget(checkKey: MenuHealthCheckKey) {
	const entityType = menuHealthEntityType(checkKey)
	return {
		action:
			entityType === 'category'
				? AuditAction.MENU_CATEGORY_UPDATED
				: AuditAction.MENU_ITEM_UPDATED,
		resourceType:
			entityType === 'item'
				? 'menu_item'
				: entityType === 'category'
					? 'menu_category'
					: 'menu_modifier_group',
	}
}

function healthKeyOrThrow(value: string): MenuHealthCheckKey {
	const key = parseMenuHealthCheckKey(value)
	if (!key) throw new MenuCheckDismissalError('invalid_input')
	return key
}

export async function dismissMenuCheck({
	organization,
	userId,
	request,
	checkKey: rawKey,
	entityId,
	reason = 'on_purpose',
}: {
	organization: Organization
	userId: string
	request?: Request
	checkKey: string
	entityId: string
	reason?: MenuCheckDismissReason
}) {
	const checkKey = healthKeyOrThrow(rawKey)
	const entityType = menuHealthEntityType(checkKey)
	const { health, data } = await loadMenuHealthWithData(organization, {
		includeFingerprints: true,
	})
	const exists =
		entityType === 'item'
			? data.items.some((row) => row.id === entityId)
			: entityType === 'category'
				? data.categories.some((row) => row.id === entityId)
				: data.modifierGroups.some((row) => row.id === entityId)
	if (!exists) throw new MenuCheckDismissalError('not_found')

	const check = health.checks.find((entry) => entry.key === checkKey)
	// Listed as failing, or already dismissed (re-dismissing refreshes it).
	const fingerprint = check?.fingerprints?.[entityId]
	if (!fingerprint) throw new MenuCheckDismissalError('not_failing')

	await db
		.insert(MenuCheckDismissal)
		.values({
			organizationId: organization.id,
			entityType,
			entityId,
			checkKey,
			reason,
			fingerprint,
			createdById: userId,
		})
		.onConflictDoUpdate({
			target: [
				MenuCheckDismissal.organizationId,
				MenuCheckDismissal.entityId,
				MenuCheckDismissal.checkKey,
			],
			set: { reason, fingerprint, createdById: userId, createdAt: new Date() },
		})

	await auditService.log({
		...auditTarget(checkKey),
		userId,
		organizationId: organization.id,
		resourceId: entityId,
		details: 'Menu health check dismissed.',
		metadata: { checkKey, reason },
		request,
	})
	return { checkKey, entityId }
}

export async function restoreMenuCheck({
	organization,
	userId,
	request,
	checkKey: rawKey,
	entityId,
}: {
	organization: { id: string }
	userId: string
	request?: Request
	checkKey: string
	entityId: string
}) {
	const checkKey = healthKeyOrThrow(rawKey)
	const deleted = await db
		.delete(MenuCheckDismissal)
		.where(
			and(
				eq(MenuCheckDismissal.organizationId, organization.id),
				eq(MenuCheckDismissal.entityId, entityId),
				eq(MenuCheckDismissal.checkKey, checkKey),
			),
		)
		.returning({ id: MenuCheckDismissal.id })
	if (deleted.length === 0) throw new MenuCheckDismissalError('not_found')
	await auditService.log({
		...auditTarget(checkKey),
		userId,
		organizationId: organization.id,
		resourceId: entityId,
		details: 'Menu health check restored.',
		metadata: { checkKey },
		request,
	})
	return { checkKey, entityId }
}
