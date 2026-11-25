import { auditService, AuditAction } from '@repo/audit'
import {
	parseMenuItemImageKeys,
	parseMenuVariations,
	type MenuVariations,
} from '@repo/common/menu-types'
import {
	parseLocalizedString,
	serializeLocalizedString,
} from '@repo/common/site-locales'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	Integration,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
	OrganizationMenuPosLink,
} from '@repo/database'
import {
	canOverridePosField,
	getAllowlistedOverrideFields,
	isPosOwnershipField,
	isPosProvider,
	parseOverriddenFields,
	parsePosValues,
	providerNames,
	resolveFieldOwnership,
	type PosEntityType,
	type PosOwnershipField,
	type PosProvider,
	type PosStoredModifierGroupValue,
} from '@repo/integrations'
import { isPosOwnershipEnabled } from '#app/utils/integrations/flags.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export const ENTITY_POS_FIELDS: Record<
	PosEntityType,
	readonly PosOwnershipField[]
> = {
	item: [
		'name',
		'description',
		'price',
		'available',
		'category',
		'modifiers',
		'photo',
		'tax',
	],
	modifier_group: ['name', 'modifiers'],
	modifier_option: ['name', 'price', 'available'],
}

export type PosLocationLock = {
	integrationId: string
	provider: PosProvider
	providerLabel: string
	lockedFields: PosOwnershipField[]
}

export type PosEntityLockInfo = {
	entityType: PosEntityType
	entityId: string
	isLinked: boolean
	providers: string[]
	providerSlugs: PosProvider[]
	integrationIds: string[]
	locationLocks: Record<string, PosLocationLock>
	lockedFields: PosOwnershipField[]
	lockedFieldProviders: Partial<Record<PosOwnershipField, string>>
	ownedFields: PosOwnershipField[]
	overriddenFields: PosOwnershipField[]
	posValues: Partial<Record<PosOwnershipField, unknown>>
	allowlistedFields: PosOwnershipField[]
	deleteLocked: boolean
	deleteLockedProvider: string | null
}

export function emptyPosLockInfo(
	entityType: PosEntityType,
	entityId: string,
): PosEntityLockInfo {
	return {
		entityType,
		entityId,
		isLinked: false,
		providers: [],
		providerSlugs: [],
		integrationIds: [],
		locationLocks: {},
		lockedFields: [],
		lockedFieldProviders: {},
		ownedFields: [],
		overriddenFields: [],
		posValues: {},
		allowlistedFields: [],
		deleteLocked: false,
		deleteLockedProvider: null,
	}
}

export class PosFieldLockedError extends Error {
	readonly code = 'field_owned_by_pos' as const

	constructor(
		readonly fields: PosOwnershipField[],
		readonly provider: string,
	) {
		super(
			`Fields [${fields.join(', ')}] are managed in ${provider} (field_owned_by_pos).`,
		)
		this.name = 'PosFieldLockedError'
	}

	toResponse(): Response {
		return fieldOwnedByPosResponse(this.fields, this.provider)
	}
}

export function fieldOwnedByPosResponse(
	fields: PosOwnershipField[],
	provider: string,
): Response {
	return Response.json(
		{
			ok: false as const,
			error: 'field_owned_by_pos' as const,
			fields,
			provider,
		},
		{ status: 409 },
	)
}

type ActiveLinkRow = {
	linkId: string
	localId: string
	remoteId: string
	posValues: string | null
	overriddenFields: string | null
	integrationId: string
	providerName: string
	config: string | null
	organizationLocationId: string | null
}

async function queryActivePosLinks(
	organizationId: string,
	entityType: PosEntityType,
	entityIds: readonly string[],
): Promise<ActiveLinkRow[]> {
	if (entityIds.length === 0) return []
	const uniqueIds = [...new Set(entityIds)]
	const out: ActiveLinkRow[] = []

	// D1 allows at most 100 bound parameters per query.
	for (let start = 0; start < uniqueIds.length; start += 80) {
		const chunk = uniqueIds.slice(start, start + 80)
		const rows = await db
			.select({
				linkId: OrganizationMenuPosLink.id,
				localId: OrganizationMenuPosLink.localId,
				remoteId: OrganizationMenuPosLink.remoteId,
				posValues: OrganizationMenuPosLink.posValues,
				overriddenFields: OrganizationMenuPosLink.overriddenFields,
				integrationId: Integration.id,
				providerName: Integration.providerName,
				config: Integration.config,
				organizationLocationId: Integration.organizationLocationId,
			})
			.from(OrganizationMenuPosLink)
			.innerJoin(
				Integration,
				eq(OrganizationMenuPosLink.integrationId, Integration.id),
			)
			.where(
				and(
					eq(OrganizationMenuPosLink.organizationId, organizationId),
					eq(OrganizationMenuPosLink.entityType, entityType),
					inArray(OrganizationMenuPosLink.localId, chunk),
					eq(Integration.organizationId, organizationId),
					eq(Integration.isActive, true),
					eq(Integration.providerType, 'pos'),
				),
			)
		out.push(...rows)
	}
	return out
}

/**
 * Resolves POS lock state per local entity ID when `integrations.pos_ownership`
 * is enabled for the organization. Returns empty locks when the flag is off.
 */
export async function lockedFieldsFor(
	organizationId: string,
	entityType: PosEntityType,
	entityIds: readonly string[],
): Promise<Map<string, PosEntityLockInfo>> {
	const result = new Map<string, PosEntityLockInfo>()
	for (const id of entityIds) {
		result.set(id, emptyPosLockInfo(entityType, id))
	}
	if (entityIds.length === 0) return result

	if (!(await isPosOwnershipEnabled(organizationId))) {
		return result
	}

	const rows = await queryActivePosLinks(organizationId, entityType, entityIds)
	const rowsByEntity = new Map<string, ActiveLinkRow[]>()
	for (const row of rows) {
		if (!isPosProvider(row.providerName)) continue
		const list = rowsByEntity.get(row.localId) ?? []
		list.push(row)
		rowsByEntity.set(row.localId, list)
	}

	const relevantFields = ENTITY_POS_FIELDS[entityType]

	for (const [entityId, entityRows] of rowsByEntity.entries()) {
		const providers: string[] = []
		const providerSlugs: PosProvider[] = []
		const integrationIds: string[] = []
		const locationLocks: Record<string, PosLocationLock> = {}
		const posValues: Partial<Record<PosOwnershipField, unknown>> = {}

		const parsedLinks = entityRows.map((row) => {
			const provider = row.providerName as PosProvider
			const providerLabel = providerNames[provider]
			if (!providers.includes(providerLabel)) providers.push(providerLabel)
			if (!providerSlugs.includes(provider)) providerSlugs.push(provider)
			if (!integrationIds.includes(row.integrationId)) {
				integrationIds.push(row.integrationId)
			}
			const ownership = resolveFieldOwnership(provider, row.config)
			const overridden = new Set(parseOverriddenFields(row.overriddenFields))
			const values = parsePosValues(row.posValues)
			const allowlisted = new Set(
				getAllowlistedOverrideFields(provider, entityType),
			)

			for (const field of relevantFields) {
				if (field in values && !(field in posValues)) {
					posValues[field] = values[field]
				}
			}

			const locKey = row.organizationLocationId ?? '*'
			const locLocked = relevantFields.filter(
				(field) => ownership[field] === 'pos' && !overridden.has(field),
			)
			const existingLoc = locationLocks[locKey]
			if (existingLoc) {
				for (const field of locLocked) {
					if (!existingLoc.lockedFields.includes(field)) {
						existingLoc.lockedFields.push(field)
					}
				}
			} else {
				locationLocks[locKey] = {
					integrationId: row.integrationId,
					provider,
					providerLabel,
					lockedFields: locLocked,
				}
			}

			return {
				row,
				provider,
				providerLabel,
				ownership,
				overridden,
				allowlisted,
			}
		})

		const ownedFields: PosOwnershipField[] = []
		const lockedFields: PosOwnershipField[] = []
		const lockedFieldProviders: Partial<Record<PosOwnershipField, string>> = {}
		const overriddenFields: PosOwnershipField[] = []
		const allowlistedFields: PosOwnershipField[] = []

		for (const field of relevantFields) {
			const owningLinks = parsedLinks.filter(
				(link) => link.ownership[field] === 'pos',
			)
			if (owningLinks.length === 0) continue

			ownedFields.push(field)
			if (owningLinks.every((link) => link.allowlisted.has(field))) {
				allowlistedFields.push(field)
			}

			const lockingLink = owningLinks.find(
				(link) => !link.overridden.has(field),
			)
			if (lockingLink) {
				lockedFields.push(field)
				lockedFieldProviders[field] = lockingLink.providerLabel
			} else {
				overriddenFields.push(field)
			}
		}

		let deleteLocked = false
		let deleteLockedProvider: string | null = null
		if (entityType === 'item') {
			const blockingLink = parsedLinks.find(
				(link) =>
					link.ownership.name === 'pos' || link.ownership.price === 'pos',
			)
			if (blockingLink) {
				deleteLocked = true
				deleteLockedProvider = blockingLink.providerLabel
			}
		}

		result.set(entityId, {
			entityType,
			entityId,
			isLinked: parsedLinks.length > 0,
			providers,
			providerSlugs,
			integrationIds,
			locationLocks,
			lockedFields,
			lockedFieldProviders,
			ownedFields,
			overriddenFields,
			posValues,
			allowlistedFields,
			deleteLocked,
			deleteLockedProvider,
		})
	}

	return result
}

export async function lockedFieldsForOne(
	organizationId: string,
	entityType: PosEntityType,
	entityId: string,
): Promise<PosEntityLockInfo> {
	const map = await lockedFieldsFor(organizationId, entityType, [entityId])
	return map.get(entityId) ?? emptyPosLockInfo(entityType, entityId)
}

export function isLocationFieldLocked(
	lock: PosEntityLockInfo,
	locationId: string,
	field: PosOwnershipField,
): { locked: boolean; provider: string | null } {
	const direct = lock.locationLocks[locationId]
	if (direct?.lockedFields.includes(field)) {
		return { locked: true, provider: direct.providerLabel }
	}
	const wildcard = lock.locationLocks['*']
	if (wildcard?.lockedFields.includes(field)) {
		return { locked: true, provider: wildcard.providerLabel }
	}
	return { locked: false, provider: null }
}

/**
 * Throws a 409-ready `PosFieldLockedError` if any of `changedFields` is locked
 * on `lock` (globally or for `options.locationId`).
 */
export function assertNoLockedFieldWrites(
	lock: PosEntityLockInfo,
	changedFields: readonly PosOwnershipField[],
	options?: { locationId?: string | null },
): void {
	if (changedFields.length === 0 || !lock.isLinked) return

	if (options?.locationId) {
		const violating: PosOwnershipField[] = []
		let provider: string | null = null
		for (const field of changedFields) {
			const check = isLocationFieldLocked(lock, options.locationId, field)
			if (check.locked) {
				violating.push(field)
				provider ??= check.provider
			}
		}
		if (violating.length > 0) {
			throw new PosFieldLockedError(
				violating,
				provider ?? lock.providers[0] ?? 'POS',
			)
		}
		return
	}

	const violating = changedFields.filter((field) =>
		lock.lockedFields.includes(field),
	)
	if (violating.length > 0) {
		const provider =
			lock.lockedFieldProviders[violating[0]!] ?? lock.providers[0] ?? 'POS'
		throw new PosFieldLockedError(violating, provider)
	}
}

/**
 * Refuses deleting a POS-linked dish (409 `field_owned_by_pos`) while any
 * connected POS owns its `name` or `price` (when `integrations.pos_ownership` is on).
 */
export async function assertCanDeleteMenuItem(
	organizationId: string,
	itemId: string,
): Promise<void> {
	const lock = await lockedFieldsForOne(organizationId, 'item', itemId)
	if (!lock.deleteLocked) return
	const fields: PosOwnershipField[] = []
	if (lock.ownedFields.includes('name')) fields.push('name')
	if (lock.ownedFields.includes('price')) fields.push('price')
	throw new PosFieldLockedError(
		fields.length > 0 ? fields : ['name'],
		lock.deleteLockedProvider ?? lock.providers[0] ?? 'POS',
	)
}

export function localizedStringsEqual(
	a: string | null | undefined,
	b: string | null | undefined,
	defaultLocale = 'en',
): boolean {
	const mapA = normalizeLocalizedMap(a, defaultLocale)
	const mapB = normalizeLocalizedMap(b, defaultLocale)
	const keys = new Set([...Object.keys(mapA), ...Object.keys(mapB)])
	for (const key of keys) {
		if ((mapA[key] ?? '') !== (mapB[key] ?? '')) return false
	}
	return true
}

function normalizeLocalizedMap(
	value: string | null | undefined,
	defaultLocale: string,
): Record<string, string> {
	const raw = parseLocalizedString(value ?? '', defaultLocale)
	const out: Record<string, string> = {}
	for (const [locale, text] of Object.entries(raw)) {
		const trimmed = text?.trim()
		if (trimmed) out[locale] = trimmed
	}
	return out
}

export function menuVariationsPriceEqual(
	a: MenuVariations,
	b: MenuVariations,
): boolean {
	if (a.groups.length !== b.groups.length) return false
	for (let i = 0; i < a.groups.length; i++) {
		const ga = a.groups[i]!
		const gb = b.groups[i]!
		if (ga.id !== gb.id || ga.name !== gb.name) return false
		if (ga.values.length !== gb.values.length) return false
		for (let j = 0; j < ga.values.length; j++) {
			if (
				ga.values[j]?.id !== gb.values[j]?.id ||
				ga.values[j]?.name !== gb.values[j]?.name
			) {
				return false
			}
		}
	}
	if (a.variants.length !== b.variants.length) return false
	for (let i = 0; i < a.variants.length; i++) {
		const va = a.variants[i]!
		const vb = b.variants[i]!
		if (
			va.id !== vb.id ||
			Math.abs(va.price - vb.price) > 1e-6 ||
			JSON.stringify(va.valueIds) !== JSON.stringify(vb.valueIds)
		) {
			return false
		}
	}
	return true
}

export function detectChangedItemPosFields(input: {
	current: {
		displayName: string
		description: string | null
		price: number
		variations: string
		imageKey: string | null
		imageUrl: string | null
		imageKeys: string
		applySalesTax: boolean
		availabilityStatus: string
		unavailableUntil: Date | null
		categoryIds: string[]
		modifierGroupIds: string[]
	}
	next: {
		displayName: string
		description: string | null
		price: number
		variations: MenuVariations
		imageKeys: string[]
		imageUrl: string | null
		applySalesTax: boolean
		availabilityStatus: string
		unavailableUntil: Date | null
		categoryIds: string[]
		modifierGroupIds: string[]
	}
	defaultLocale?: string
}): PosOwnershipField[] {
	const { current, next, defaultLocale = 'en' } = input
	const changed: PosOwnershipField[] = []

	if (
		!localizedStringsEqual(current.displayName, next.displayName, defaultLocale)
	) {
		changed.push('name')
	}

	if (
		!localizedStringsEqual(current.description, next.description, defaultLocale)
	) {
		changed.push('description')
	}

	const currentVariations = parseMenuVariations(current.variations)
	if (
		Math.abs(current.price - next.price) > 1e-6 ||
		!menuVariationsPriceEqual(currentVariations, next.variations)
	) {
		changed.push('price')
	}

	const currentImageKeys = parseMenuItemImageKeys(
		current.imageKeys,
		current.imageKey,
	)
	const keysChanged =
		JSON.stringify(currentImageKeys) !== JSON.stringify(next.imageKeys)
	const externalUrlChanged =
		currentImageKeys.length === 0 &&
		next.imageKeys.length === 0 &&
		(current.imageUrl ?? null) !== (next.imageUrl ?? null)
	if (keysChanged || externalUrlChanged) {
		changed.push('photo')
	}

	if (current.applySalesTax !== next.applySalesTax) {
		changed.push('tax')
	}

	const curUntil = current.unavailableUntil?.getTime() ?? null
	const nextUntil = next.unavailableUntil?.getTime() ?? null
	if (
		current.availabilityStatus !== next.availabilityStatus ||
		curUntil !== nextUntil
	) {
		changed.push('available')
	}

	if (
		JSON.stringify(current.categoryIds) !== JSON.stringify(next.categoryIds)
	) {
		changed.push('category')
	}

	if (
		JSON.stringify(current.modifierGroupIds) !==
		JSON.stringify(next.modifierGroupIds)
	) {
		changed.push('modifiers')
	}

	return changed
}

async function readCurrentPosFallbackValue(
	organizationId: string,
	entityType: PosEntityType,
	entityId: string,
	field: PosOwnershipField,
	defaultLocale: string,
): Promise<{ found: boolean; value: unknown }> {
	if (entityType === 'item') {
		const [item] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.id, entityId),
					eq(OrganizationMenuItem.organizationId, organizationId),
				),
			)
			.limit(1)
		if (!item) return { found: false, value: undefined }
		const plain = (val: string | null) => {
			const map = parseLocalizedString(val ?? '', defaultLocale)
			return map[defaultLocale] ?? Object.values(map).find(Boolean) ?? null
		}
		if (field === 'name') {
			return { found: true, value: plain(item.displayName) ?? item.displayName }
		}
		if (field === 'description') {
			return { found: true, value: plain(item.description) }
		}
		if (field === 'price') return { found: true, value: item.price }
		if (field === 'photo') return { found: true, value: item.imageUrl ?? null }
		if (field === 'modifiers') {
			const assignments = await db
				.select({
					modifierGroupId:
						OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
				})
				.from(OrganizationMenuItemModifierGroupAssignment)
				.where(eq(OrganizationMenuItemModifierGroupAssignment.itemId, entityId))
				.orderBy(asc(OrganizationMenuItemModifierGroupAssignment.position))
			return {
				found: true,
				value: assignments.map((a) => ({ localId: a.modifierGroupId })),
			}
		}
		return { found: true, value: null }
	}

	if (entityType === 'modifier_group') {
		const [group] = await db
			.select()
			.from(OrganizationMenuModifierGroup)
			.where(
				and(
					eq(OrganizationMenuModifierGroup.id, entityId),
					eq(OrganizationMenuModifierGroup.organizationId, organizationId),
				),
			)
			.limit(1)
		if (!group) return { found: false, value: undefined }
		if (field === 'name') {
			const map = parseLocalizedString(group.name, defaultLocale)
			return {
				found: true,
				value:
					map[defaultLocale] ?? Object.values(map).find(Boolean) ?? group.name,
			}
		}
		return { found: true, value: null }
	}

	const [option] = await db
		.select()
		.from(OrganizationMenuOption)
		.where(
			and(
				eq(OrganizationMenuOption.id, entityId),
				eq(OrganizationMenuOption.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!option) return { found: false, value: undefined }
	if (field === 'name') {
		const map = parseLocalizedString(option.displayName, defaultLocale)
		return {
			found: true,
			value:
				map[defaultLocale] ??
				Object.values(map).find(Boolean) ??
				option.displayName,
		}
	}
	if (field === 'price') return { found: true, value: option.price }
	return { found: true, value: null }
}

function auditResourceTypeFor(entityType: PosEntityType) {
	if (entityType === 'item') return 'menu_item'
	if (entityType === 'modifier_group') return 'menu_modifier_group'
	return 'menu_option'
}

/**
 * Marks an allowlisted POS-owned field as locally overridden ("Use my own").
 */
export async function overridePosField({
	organization,
	userId,
	request,
	entityType,
	entityId,
	field,
	defaultLocale = 'en',
}: {
	organization: { id: string; slug: string }
	userId: string
	request?: Request
	entityType: PosEntityType
	entityId: string
	field: string
	defaultLocale?: string
}): Promise<
	| { ok: true; field: PosOwnershipField }
	| {
			ok: false
			status: 400 | 403 | 404
			error:
				| 'feature_off'
				| 'invalid_field'
				| 'field_not_pos_owned'
				| 'field_not_overridable'
			provider?: string
	  }
> {
	if (!isPosOwnershipField(field)) {
		return { ok: false, status: 400, error: 'invalid_field' }
	}
	if (!(await isPosOwnershipEnabled(organization.id))) {
		return { ok: false, status: 404, error: 'feature_off' }
	}

	const rows = await queryActivePosLinks(organization.id, entityType, [
		entityId,
	])
	const validRows = rows.filter((row) => isPosProvider(row.providerName))
	if (validRows.length === 0) {
		return { ok: false, status: 400, error: 'field_not_pos_owned' }
	}

	const owningRows = validRows.filter((row) => {
		const ownership = resolveFieldOwnership(
			row.providerName as PosProvider,
			row.config,
		)
		return ownership[field] === 'pos'
	})

	if (owningRows.length === 0) {
		return { ok: false, status: 400, error: 'field_not_pos_owned' }
	}

	const disallowing = owningRows.find(
		(row) =>
			!canOverridePosField(row.providerName as PosProvider, entityType, field),
	)
	if (disallowing) {
		return {
			ok: false,
			status: 403,
			error: 'field_not_overridable',
			provider: providerNames[disallowing.providerName as PosProvider],
		}
	}

	const fallback = await readCurrentPosFallbackValue(
		organization.id,
		entityType,
		entityId,
		field,
		defaultLocale,
	)
	if (!fallback.found) {
		return { ok: false, status: 404, error: 'feature_off' }
	}

	const now = new Date()
	for (const row of owningRows) {
		const currentOverridden = parseOverriddenFields(row.overriddenFields)
		const nextOverridden = currentOverridden.includes(field)
			? currentOverridden
			: [...currentOverridden, field]
		const currentPosValues = parsePosValues(row.posValues)
		if (!(field in currentPosValues)) {
			currentPosValues[field] = fallback.value
		}
		await db
			.update(OrganizationMenuPosLink)
			.set({
				overriddenFields: JSON.stringify(nextOverridden),
				posValues: JSON.stringify(currentPosValues),
				updatedAt: now,
			})
			.where(eq(OrganizationMenuPosLink.id, row.linkId))
	}

	await auditService.log({
		action: AuditAction.MENU_ITEM_UPDATED,
		userId,
		organizationId: organization.id,
		resourceType: auditResourceTypeFor(entityType),
		resourceId: entityId,
		details: `Overrode POS field "${field}" on ${entityType} ("Use my own").`,
		metadata: {
			posOverride: 'override',
			entityType,
			field,
			providers: owningRows.map(
				(r) => providerNames[r.providerName as PosProvider],
			),
		},
		request,
	})
	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return { ok: true, field }
}

function restoreLocalizedColumn(
	existing: string | null | undefined,
	restoredPlain: string | null,
	defaultLocale: string,
	allowNull: boolean,
): string | null {
	const map = parseLocalizedString(existing ?? '', defaultLocale)
	if (restoredPlain && restoredPlain.trim()) {
		map[defaultLocale] = restoredPlain
	} else {
		delete map[defaultLocale]
	}
	const serialized = serializeLocalizedString(map)
	if (serialized === '{}') {
		return allowNull ? null : JSON.stringify({ [defaultLocale]: '' })
	}
	return serialized
}

/**
 * Restores a locally overridden field back to its latest stored POS value
 * ("Restore from POS") and locks it again.
 */
export async function restorePosField({
	organization,
	userId,
	request,
	entityType,
	entityId,
	field,
	defaultLocale = 'en',
}: {
	organization: { id: string; slug: string }
	userId: string
	request?: Request
	entityType: PosEntityType
	entityId: string
	field: string
	defaultLocale?: string
}): Promise<
	| { ok: true; field: PosOwnershipField; restoredValue: unknown }
	| {
			ok: false
			status: 400 | 404
			error: 'feature_off' | 'invalid_field' | 'not_linked'
	  }
> {
	if (!isPosOwnershipField(field)) {
		return { ok: false, status: 400, error: 'invalid_field' }
	}
	if (!(await isPosOwnershipEnabled(organization.id))) {
		return { ok: false, status: 404, error: 'feature_off' }
	}

	const rows = await queryActivePosLinks(organization.id, entityType, [
		entityId,
	])
	const validRows = rows.filter((row) => isPosProvider(row.providerName))
	if (validRows.length === 0) {
		return { ok: false, status: 404, error: 'not_linked' }
	}

	let hasStoredValue = false
	let restoredValue: unknown = undefined
	let sourceIntegrationId = validRows[0]!.integrationId

	for (const row of validRows) {
		const posVals = parsePosValues(row.posValues)
		if (field in posVals) {
			hasStoredValue = true
			restoredValue = posVals[field]
			sourceIntegrationId = row.integrationId
			break
		}
	}

	const now = new Date()
	await db.transaction(async (tx) => {
		for (const row of validRows) {
			const nextOverridden = parseOverriddenFields(row.overriddenFields).filter(
				(entry) => entry !== field,
			)
			await tx
				.update(OrganizationMenuPosLink)
				.set({
					overriddenFields: JSON.stringify(nextOverridden),
					updatedAt: now,
				})
				.where(eq(OrganizationMenuPosLink.id, row.linkId))
		}

		if (!hasStoredValue) return

		if (entityType === 'item') {
			const [current] = await tx
				.select()
				.from(OrganizationMenuItem)
				.where(
					and(
						eq(OrganizationMenuItem.id, entityId),
						eq(OrganizationMenuItem.organizationId, organization.id),
					),
				)
				.limit(1)
			if (!current) return

			if (field === 'name') {
				const nextName = restoreLocalizedColumn(
					current.displayName,
					typeof restoredValue === 'string' ? restoredValue : '',
					defaultLocale,
					false,
				)!
				await tx
					.update(OrganizationMenuItem)
					.set({ displayName: nextName, updatedAt: now })
					.where(eq(OrganizationMenuItem.id, entityId))
			} else if (field === 'description') {
				const nextDesc = restoreLocalizedColumn(
					current.description,
					typeof restoredValue === 'string' ? restoredValue : null,
					defaultLocale,
					true,
				)
				await tx
					.update(OrganizationMenuItem)
					.set({ description: nextDesc, updatedAt: now })
					.where(eq(OrganizationMenuItem.id, entityId))
			} else if (field === 'price' && typeof restoredValue === 'number') {
				await tx
					.update(OrganizationMenuItem)
					.set({ price: restoredValue, updatedAt: now })
					.where(eq(OrganizationMenuItem.id, entityId))
			} else if (field === 'photo') {
				const photoUrl =
					typeof restoredValue === 'string' ? restoredValue : null
				await tx
					.update(OrganizationMenuItem)
					.set({
						imageUrl: photoUrl,
						imageKey: null,
						imageKeys: '[]',
						updatedAt: now,
					})
					.where(eq(OrganizationMenuItem.id, entityId))
			} else if (field === 'modifiers' && Array.isArray(restoredValue)) {
				const orderedGroupIds: string[] = []
				for (const entry of restoredValue as Array<
					PosStoredModifierGroupValue | { localId?: string }
				>) {
					if ('localId' in entry && typeof entry.localId === 'string') {
						orderedGroupIds.push(entry.localId)
						continue
					}
					if ('id' in entry && typeof entry.id === 'string') {
						const [groupLink] = await tx
							.select({ localId: OrganizationMenuPosLink.localId })
							.from(OrganizationMenuPosLink)
							.where(
								and(
									eq(
										OrganizationMenuPosLink.integrationId,
										sourceIntegrationId,
									),
									eq(OrganizationMenuPosLink.entityType, 'modifier_group'),
									eq(OrganizationMenuPosLink.remoteId, entry.id),
								),
							)
							.limit(1)
						if (groupLink) orderedGroupIds.push(groupLink.localId)
					}
				}
				await tx
					.delete(OrganizationMenuItemModifierGroupAssignment)
					.where(
						eq(OrganizationMenuItemModifierGroupAssignment.itemId, entityId),
					)
				if (orderedGroupIds.length > 0) {
					await tx.insert(OrganizationMenuItemModifierGroupAssignment).values(
						orderedGroupIds.map((modifierGroupId, position) => ({
							itemId: entityId,
							modifierGroupId,
							position,
						})),
					)
				}
			} else if (field === 'category' && typeof restoredValue === 'string') {
				const [cat] = await tx
					.select({ id: OrganizationMenuCategory.id })
					.from(OrganizationMenuCategory)
					.where(
						and(
							eq(OrganizationMenuCategory.organizationId, organization.id),
							eq(OrganizationMenuCategory.displayName, restoredValue),
						),
					)
					.limit(1)
				if (cat) {
					await tx
						.delete(OrganizationMenuItemCategoryAssignment)
						.where(eq(OrganizationMenuItemCategoryAssignment.itemId, entityId))
					await tx.insert(OrganizationMenuItemCategoryAssignment).values({
						categoryId: cat.id,
						itemId: entityId,
						position: 0,
					})
				}
			}
		} else if (entityType === 'modifier_group') {
			const [current] = await tx
				.select()
				.from(OrganizationMenuModifierGroup)
				.where(
					and(
						eq(OrganizationMenuModifierGroup.id, entityId),
						eq(OrganizationMenuModifierGroup.organizationId, organization.id),
					),
				)
				.limit(1)
			if (current && field === 'name') {
				const nextName = restoreLocalizedColumn(
					current.name,
					typeof restoredValue === 'string' ? restoredValue : '',
					defaultLocale,
					false,
				)!
				await tx
					.update(OrganizationMenuModifierGroup)
					.set({ name: nextName, updatedAt: now })
					.where(eq(OrganizationMenuModifierGroup.id, entityId))
			}
		} else if (entityType === 'modifier_option') {
			const [current] = await tx
				.select()
				.from(OrganizationMenuOption)
				.where(
					and(
						eq(OrganizationMenuOption.id, entityId),
						eq(OrganizationMenuOption.organizationId, organization.id),
					),
				)
				.limit(1)
			if (current && field === 'name') {
				const nextName = restoreLocalizedColumn(
					current.displayName,
					typeof restoredValue === 'string' ? restoredValue : '',
					defaultLocale,
					false,
				)!
				await tx
					.update(OrganizationMenuOption)
					.set({ displayName: nextName, updatedAt: now })
					.where(eq(OrganizationMenuOption.id, entityId))
			} else if (
				current &&
				field === 'price' &&
				typeof restoredValue === 'number'
			) {
				await tx
					.update(OrganizationMenuOption)
					.set({
						price: restoredValue,
						...(current.isTopping ? { priceWhole: restoredValue } : {}),
						updatedAt: now,
					})
					.where(eq(OrganizationMenuOption.id, entityId))
			}
		}
	})

	await auditService.log({
		action: AuditAction.MENU_ITEM_UPDATED,
		userId,
		organizationId: organization.id,
		resourceType: auditResourceTypeFor(entityType),
		resourceId: entityId,
		details: `Restored POS field "${field}" on ${entityType} ("Restore from POS").`,
		metadata: {
			posOverride: 'restore',
			entityType,
			field,
			restoredValue: restoredValue ?? null,
		},
		request,
	})
	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return { ok: true, field, restoredValue }
}

/**
 * Shared formData intent dispatcher for `override-pos-field` and `restore-pos-field`
 * across dish, option, and modifier-group routes. Returns `null` when `intent`
 * is neither of those.
 */
export async function handlePosFieldOverrideIntent({
	organization,
	userId,
	request,
	formData,
	entityType,
	entityId,
	defaultLocale = 'en',
}: {
	organization: { id: string; slug: string }
	userId: string
	request: Request
	formData: FormData
	entityType: PosEntityType
	entityId: string
	defaultLocale?: string
}): Promise<Response | null> {
	const intent = formData.get('intent')
	if (intent !== 'override-pos-field' && intent !== 'restore-pos-field') {
		return null
	}
	const field = String(formData.get('field') ?? '').trim()

	if (intent === 'override-pos-field') {
		const res = await overridePosField({
			organization,
			userId,
			request,
			entityType,
			entityId,
			field,
			defaultLocale,
		})
		if (!res.ok) {
			return Response.json(
				{
					ok: false,
					error: res.error,
					field,
					...(res.provider ? { provider: res.provider } : {}),
				},
				{ status: res.status },
			)
		}
		return Response.json({ ok: true, intent, field: res.field })
	}

	const res = await restorePosField({
		organization,
		userId,
		request,
		entityType,
		entityId,
		field,
		defaultLocale,
	})
	if (!res.ok) {
		return Response.json(
			{ ok: false, error: res.error, field },
			{ status: res.status },
		)
	}
	return Response.json({
		ok: true,
		intent,
		field: res.field,
		restoredValue: res.restoredValue,
	})
}

/**
 * Returns the set of item IDs in an organization that have at least one active
 * POS field override ("Yours, not from POS") while `integrations.pos_ownership` is on.
 */
export async function listOverriddenPosItemIds(
	organizationId: string,
): Promise<Set<string>> {
	if (!(await isPosOwnershipEnabled(organizationId))) {
		return new Set()
	}
	const rows = await db
		.select({
			localId: OrganizationMenuPosLink.localId,
			overriddenFields: OrganizationMenuPosLink.overriddenFields,
			providerName: Integration.providerName,
			config: Integration.config,
		})
		.from(OrganizationMenuPosLink)
		.innerJoin(
			Integration,
			eq(OrganizationMenuPosLink.integrationId, Integration.id),
		)
		.where(
			and(
				eq(OrganizationMenuPosLink.organizationId, organizationId),
				eq(OrganizationMenuPosLink.entityType, 'item'),
				eq(Integration.organizationId, organizationId),
				eq(Integration.isActive, true),
				eq(Integration.providerType, 'pos'),
			),
		)

	const out = new Set<string>()
	for (const row of rows) {
		if (!isPosProvider(row.providerName)) continue
		const ownership = resolveFieldOwnership(
			row.providerName as PosProvider,
			row.config,
		)
		const overridden = parseOverriddenFields(row.overriddenFields)
		if (overridden.some((field) => ownership[field] === 'pos')) {
			out.add(row.localId)
		}
	}
	return out
}
