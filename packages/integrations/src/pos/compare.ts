/**
 * Pure delivery-platform menu comparison (#144).
 *
 * Compares Menuza's projected local menu (`RemoteItem[]`) against a delivery
 * platform's live catalog (`RemoteItem[]`), scoped strictly to
 * `providerReadFields` (`readFields[provider]`), matching dishes by
 * normalized name (`normalizeMenuName`), and marking POS-owned non-overridden
 * diffs as `changedInPos: true` rather than errors.
 */

import { type PosOwnershipField } from './ownership.ts'
import { type MenuField, type RemoteItem } from './types.ts'

export const MAX_STORED_MENU_DIFFS = 100

const PUNCTUATION = /\p{P}+/gu
const SPACES = /\s+/gu
const ARABIC_MARKS = /[\u0640\u064B-\u065F\u0670]/gu

/**
 * Normalizes a dish, group, or option name for case- and
 * whitespace-insensitive matching (with punctuation stripping and Arabic
 * diacritic/alef folding matching Menuza's duplicate detector).
 */
export function normalizeMenuName(name: string): string {
	const normalized = name
		.normalize('NFKC')
		.replace(ARABIC_MARKS, '')
		.replace(/[أإآٱ]/gu, 'ا')
		.replace(/ى/gu, 'ي')
		.toLowerCase()
		.replace(PUNCTUATION, '')
		.replace(SPACES, ' ')
		.trim()
	return normalized || name.trim().toLowerCase().replace(SPACES, ' ')
}

export type MenuDiffKind =
	'missing' | 'extra' | 'price' | 'available' | 'modifiers'

export type MenuDiff = {
	kind: MenuDiffKind
	dishName: string
	localItemId?: string
	remoteItemId?: string
	/** Minor units (cents) when kind === 'price' or modifier option price diff */
	localPrice?: number
	remotePrice?: number
	localAvailable?: boolean
	remoteAvailable?: boolean
	groupName?: string
	optionName?: string
	detail?: string
	changedInPos: boolean
}

export type PosCompareItemOwnership = {
	ownedFields?: readonly PosOwnershipField[] | ReadonlySet<PosOwnershipField>
	overriddenFields?:
		readonly PosOwnershipField[] | ReadonlySet<PosOwnershipField>
	posLinked?: boolean
}

export type PosCompareOwnership = {
	ownedFields?: readonly PosOwnershipField[] | ReadonlySet<PosOwnershipField>
	itemsById?:
		| ReadonlyMap<string, PosCompareItemOwnership>
		| Record<string, PosCompareItemOwnership>
	itemsByName?:
		| ReadonlyMap<string, PosCompareItemOwnership>
		| Record<string, PosCompareItemOwnership>
	managedByPos?: boolean
}

export type CompareStoreMenuOptions = {
	maxDiffs?: number
}

export type CompareStoreMenuResult = {
	diffs: MenuDiff[]
	errorDiffCount: number
	posChangedCount: number
	totalDiffCount: number
}

function toFieldSet(
	fields:
		readonly PosOwnershipField[] | ReadonlySet<PosOwnershipField> | undefined,
): ReadonlySet<PosOwnershipField> | undefined {
	if (!fields) return undefined
	return fields instanceof Set ? fields : new Set(fields)
}

function lookupItemOwnership(
	ownership: PosCompareOwnership | undefined,
	localItem: RemoteItem | undefined,
	remoteItem: RemoteItem | undefined,
): PosCompareItemOwnership | undefined {
	if (!ownership) return undefined
	if (localItem?.id && ownership.itemsById) {
		const hit =
			ownership.itemsById instanceof Map
				? ownership.itemsById.get(localItem.id)
				: (ownership.itemsById as Record<string, PosCompareItemOwnership>)[
						localItem.id
					]
		if (hit) return hit
	}
	const name = localItem?.name ?? remoteItem?.name
	if (name && ownership.itemsByName) {
		const key = normalizeMenuName(name)
		const hit =
			ownership.itemsByName instanceof Map
				? ownership.itemsByName.get(key)
				: (ownership.itemsByName as Record<string, PosCompareItemOwnership>)[
						key
					]
		if (hit) return hit
	}
	return undefined
}

function isDiffChangedInPos(
	field: PosOwnershipField,
	ownership: PosCompareOwnership | undefined,
	localItem: RemoteItem | undefined,
	remoteItem: RemoteItem | undefined,
): boolean {
	if (!ownership) return false
	const itemOwnership = lookupItemOwnership(ownership, localItem, remoteItem)
	const defaultOwned = toFieldSet(ownership.ownedFields)
	if (itemOwnership) {
		const overridden = toFieldSet(itemOwnership.overriddenFields)
		if (overridden?.has(field)) return false
		const itemOwned = toFieldSet(itemOwnership.ownedFields) ?? defaultOwned
		return Boolean(itemOwned?.has(field))
	}
	if (ownership.managedByPos) {
		return Boolean(defaultOwned?.has(field))
	}
	// Shorthand for direct tests passing `{ ownedFields: [...] }` without per-item maps.
	const hasPerItemMaps =
		ownership.itemsById !== undefined || ownership.itemsByName !== undefined
	if (!hasPerItemMaps && defaultOwned?.has(field)) {
		return true
	}
	return false
}

function compareModifiers(
	local: RemoteItem,
	remote: RemoteItem,
	changedInPos: boolean,
): MenuDiff[] {
	const diffs: MenuDiff[] = []
	const remoteGroupsByName = new Map<string, RemoteItem['modifierGroups']>()
	for (const group of remote.modifierGroups ?? []) {
		const key = normalizeMenuName(group.name)
		const list = remoteGroupsByName.get(key) ?? []
		list.push(group)
		remoteGroupsByName.set(key, list)
	}

	const matchedRemoteGroups = new Set<RemoteItem['modifierGroups'][number]>()

	for (const localGroup of local.modifierGroups ?? []) {
		const key = normalizeMenuName(localGroup.name)
		const candidates = remoteGroupsByName.get(key) ?? []
		const remoteGroup = candidates.find(
			(candidate) => !matchedRemoteGroups.has(candidate),
		)
		if (!remoteGroup) {
			diffs.push({
				kind: 'modifiers',
				dishName: local.name,
				localItemId: local.id,
				remoteItemId: remote.id,
				groupName: localGroup.name,
				detail: `Missing modifier group "${localGroup.name}"`,
				changedInPos,
			})
			continue
		}
		matchedRemoteGroups.add(remoteGroup)

		const remoteOptionsByName = new Map<string, typeof remoteGroup.options>()
		for (const opt of remoteGroup.options ?? []) {
			const optKey = normalizeMenuName(opt.name)
			const list = remoteOptionsByName.get(optKey) ?? []
			list.push(opt)
			remoteOptionsByName.set(optKey, list)
		}

		const matchedRemoteOptions = new Set<(typeof remoteGroup.options)[number]>()
		for (const localOpt of localGroup.options ?? []) {
			const optKey = normalizeMenuName(localOpt.name)
			const optCandidates = remoteOptionsByName.get(optKey) ?? []
			const remoteOpt = optCandidates.find(
				(candidate) => !matchedRemoteOptions.has(candidate),
			)
			if (!remoteOpt) {
				diffs.push({
					kind: 'modifiers',
					dishName: local.name,
					localItemId: local.id,
					remoteItemId: remote.id,
					groupName: localGroup.name,
					optionName: localOpt.name,
					detail: `Missing option "${localOpt.name}" in "${localGroup.name}"`,
					changedInPos,
				})
				continue
			}
			matchedRemoteOptions.add(remoteOpt)

			const localPrice = Math.round(localOpt.price)
			const remotePrice = Math.round(remoteOpt.price)
			if (localPrice !== remotePrice) {
				diffs.push({
					kind: 'modifiers',
					dishName: local.name,
					localItemId: local.id,
					remoteItemId: remote.id,
					groupName: localGroup.name,
					optionName: localOpt.name,
					localPrice,
					remotePrice,
					detail: `Option "${localOpt.name}" price differs in "${localGroup.name}"`,
					changedInPos,
				})
			}

			const localOptAvail = localOpt.available !== false
			const remoteOptAvail = remoteOpt.available !== false
			if (localOptAvail !== remoteOptAvail) {
				diffs.push({
					kind: 'modifiers',
					dishName: local.name,
					localItemId: local.id,
					remoteItemId: remote.id,
					groupName: localGroup.name,
					optionName: localOpt.name,
					localAvailable: localOptAvail,
					remoteAvailable: remoteOptAvail,
					detail: `Option "${localOpt.name}" availability differs in "${localGroup.name}"`,
					changedInPos,
				})
			}
		}

		for (const remoteOpt of remoteGroup.options ?? []) {
			if (matchedRemoteOptions.has(remoteOpt)) continue
			diffs.push({
				kind: 'modifiers',
				dishName: local.name,
				localItemId: local.id,
				remoteItemId: remote.id,
				groupName: localGroup.name,
				optionName: remoteOpt.name,
				detail: `Extra option "${remoteOpt.name}" in "${localGroup.name}"`,
				changedInPos,
			})
		}
	}

	for (const remoteGroup of remote.modifierGroups ?? []) {
		if (matchedRemoteGroups.has(remoteGroup)) continue
		diffs.push({
			kind: 'modifiers',
			dishName: local.name,
			localItemId: local.id,
			remoteItemId: remote.id,
			groupName: remoteGroup.name,
			detail: `Extra modifier group "${remoteGroup.name}"`,
			changedInPos,
		})
	}

	return diffs
}

/**
 * Compares expected Menuza catalog items against a delivery platform's live
 * catalog items, scoped to `providerReadFields`.
 */
export function compareStoreMenu(
	localItems: readonly RemoteItem[],
	remoteItems: readonly RemoteItem[],
	providerReadFields: readonly MenuField[] | ReadonlySet<MenuField>,
	posOwnership?: PosCompareOwnership,
	options?: CompareStoreMenuOptions,
): CompareStoreMenuResult {
	const readSet =
		providerReadFields instanceof Set
			? providerReadFields
			: new Set(providerReadFields)
	const maxDiffs = Math.max(1, options?.maxDiffs ?? MAX_STORED_MENU_DIFFS)

	const remoteByName = new Map<string, RemoteItem[]>()
	for (const remote of remoteItems) {
		const key = normalizeMenuName(remote.name)
		const list = remoteByName.get(key) ?? []
		list.push(remote)
		remoteByName.set(key, list)
	}

	const matchedRemote = new Set<RemoteItem>()
	const allDiffs: MenuDiff[] = []

	for (const local of localItems) {
		const key = normalizeMenuName(local.name)
		const candidates = remoteByName.get(key) ?? []
		const remote = candidates.find((candidate) => !matchedRemote.has(candidate))

		if (!remote) {
			if (readSet.has('name')) {
				allDiffs.push({
					kind: 'missing',
					dishName: local.name,
					localItemId: local.id,
					changedInPos: isDiffChangedInPos(
						'name',
						posOwnership,
						local,
						undefined,
					),
				})
			}
			continue
		}

		matchedRemote.add(remote)

		if (readSet.has('price')) {
			const localPrice = Math.round(local.price)
			const remotePrice = Math.round(remote.price)
			if (localPrice !== remotePrice) {
				allDiffs.push({
					kind: 'price',
					dishName: local.name,
					localItemId: local.id,
					remoteItemId: remote.id,
					localPrice,
					remotePrice,
					changedInPos: isDiffChangedInPos(
						'price',
						posOwnership,
						local,
						remote,
					),
				})
			}
		}

		if (readSet.has('available')) {
			const localAvailable = Boolean(local.available)
			const remoteAvailable = Boolean(remote.available)
			if (localAvailable !== remoteAvailable) {
				allDiffs.push({
					kind: 'available',
					dishName: local.name,
					localItemId: local.id,
					remoteItemId: remote.id,
					localAvailable,
					remoteAvailable,
					changedInPos: isDiffChangedInPos(
						'available',
						posOwnership,
						local,
						remote,
					),
				})
			}
		}

		if (readSet.has('modifiers')) {
			const modifiersChangedInPos = isDiffChangedInPos(
				'modifiers',
				posOwnership,
				local,
				remote,
			)
			allDiffs.push(...compareModifiers(local, remote, modifiersChangedInPos))
		}
	}

	if (readSet.has('name')) {
		for (const remote of remoteItems) {
			if (matchedRemote.has(remote)) continue
			allDiffs.push({
				kind: 'extra',
				dishName: remote.name,
				remoteItemId: remote.id,
				changedInPos: isDiffChangedInPos(
					'name',
					posOwnership,
					undefined,
					remote,
				),
			})
		}
	}

	const totalDiffCount = allDiffs.length
	const posChangedCount = allDiffs.filter((diff) => diff.changedInPos).length
	const errorDiffCount = totalDiffCount - posChangedCount

	return {
		diffs: allDiffs.slice(0, maxDiffs),
		errorDiffCount,
		posChangedCount,
		totalDiffCount,
	}
}
