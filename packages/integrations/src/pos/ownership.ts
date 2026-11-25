/**
 * Per-connection POS field ownership, declarative override allowlist, and
 * remote snapshot hashing/value extraction (#93).
 */

import { sha256 } from '@oslojs/crypto/sha2'
import { encodeHexLowerCase } from '@oslojs/encoding'
import {
	readFields,
	type MenuField,
	type PosProvider,
	type RemoteItem,
	type RemoteModifierGroup,
	type RemoteOption,
} from './types.ts'
import { slug } from './wire.ts'

/**
 * Menu fields exposed in the "Who owns what" panel on each POS connection.
 * Every entry maps cleanly to a canonical `MenuField`.
 */
export const posOwnershipFields = [
	'name',
	'description',
	'price',
	'available',
	'category',
	'modifiers',
	'photo',
	'tax',
] as const satisfies readonly MenuField[]

export type PosOwnershipField = (typeof posOwnershipFields)[number]
export type FieldOwner = 'pos' | 'menuza'
export type PosFieldOwnership = Record<PosOwnershipField, FieldOwner>
export type PosEntityType = 'item' | 'modifier_group' | 'modifier_option'

export function isPosOwnershipField(value: string): value is PosOwnershipField {
	return (posOwnershipFields as readonly string[]).includes(value)
}

/** A field can be POS-owned only when the provider's read catalog exposes it. */
export function canProviderOwnField(
	provider: PosProvider,
	field: PosOwnershipField,
): boolean {
	return readFields[provider].includes(field)
}

/** Default ownership per provider: fields in `readFields[provider]` default to `'pos'`, others to `'menuza'`. */
export function defaultFieldOwnership(
	provider: PosProvider,
): PosFieldOwnership {
	const result = {} as PosFieldOwnership
	for (const field of posOwnershipFields) {
		result[field] = canProviderOwnField(provider, field) ? 'pos' : 'menuza'
	}
	return result
}

/** Parses an optional `fieldOwnership` object without throwing on malformed JSON/values. */
export function parseFieldOwnership(
	raw: unknown,
): Partial<Record<PosOwnershipField, FieldOwner>> | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
	const record = raw as Record<string, unknown>
	const out: Partial<Record<PosOwnershipField, FieldOwner>> = {}
	let hasAny = false
	for (const field of posOwnershipFields) {
		const value = record[field]
		if (value === 'pos' || value === 'menuza') {
			out[field] = value
			hasAny = true
		}
	}
	return hasAny ? out : undefined
}

/**
 * Validates a submitted field ownership map for `save-pos-ownership`.
 * Rejects unknown fields, non-owner values, or setting `'pos'` on a field
 * that `readFields[provider]` does not include.
 */
export function validateFieldOwnership(
	provider: PosProvider,
	input: unknown,
):
	| { ok: true; fieldOwnership: PosFieldOwnership }
	| { ok: false; invalidFields: string[] } {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return { ok: false, invalidFields: ['fieldOwnership'] }
	}
	const record = input as Record<string, unknown>
	const invalidFields: string[] = []
	const next = defaultFieldOwnership(provider)

	for (const [key, value] of Object.entries(record)) {
		if (!isPosOwnershipField(key)) {
			invalidFields.push(key)
			continue
		}
		if (value !== 'pos' && value !== 'menuza') {
			invalidFields.push(key)
			continue
		}
		if (value === 'pos' && !canProviderOwnField(provider, key)) {
			invalidFields.push(key)
			continue
		}
		next[key] = value
	}

	if (invalidFields.length > 0) {
		return { ok: false, invalidFields }
	}
	return { ok: true, fieldOwnership: next }
}

/**
 * Declarative per-integration override allowlist table (#93).
 *
 * A POS-owned field may be overridden via "Use my own" ONLY when listed here
 * for that provider and entity type, so sync leaves the overridden value alone.
 * `price` is allowed ONLY when `honoursPriceOverride` is `true` (false on
 * Square, Clover, and Toast so `price`, `tax`, and `category` stay locked).
 */
export type PosOverridePolicy = {
	honoursPriceOverride: boolean
	item: readonly PosOwnershipField[]
	modifier_group: readonly PosOwnershipField[]
	modifier_option: readonly PosOwnershipField[]
}

export const OVERRIDE_ALLOWLIST: Record<PosProvider, PosOverridePolicy> = {
	clover: {
		honoursPriceOverride: false,
		item: ['name', 'description', 'photo', 'modifiers'],
		modifier_group: ['name'],
		modifier_option: ['name'],
	},
	square: {
		honoursPriceOverride: false,
		item: ['name', 'description', 'photo', 'modifiers'],
		modifier_group: ['name'],
		modifier_option: ['name'],
	},
	toast: {
		honoursPriceOverride: false,
		item: ['name', 'description', 'photo', 'modifiers'],
		modifier_group: ['name'],
		modifier_option: ['name'],
	},
	ubereats: {
		honoursPriceOverride: true,
		item: ['name', 'description', 'photo', 'modifiers'],
		modifier_group: ['name'],
		modifier_option: ['name'],
	},
	doordash: {
		honoursPriceOverride: true,
		item: ['name', 'description', 'photo', 'modifiers'],
		modifier_group: ['name'],
		modifier_option: ['name'],
	},
}

export function getAllowlistedOverrideFields(
	provider: PosProvider,
	entityType: PosEntityType,
): PosOwnershipField[] {
	const policy = OVERRIDE_ALLOWLIST[provider]
	if (!policy) return []
	const allowed = [...policy[entityType]]
	if (
		policy.honoursPriceOverride &&
		(entityType === 'item' || entityType === 'modifier_option') &&
		!allowed.includes('price')
	) {
		allowed.push('price')
	}
	return allowed.filter((field) => canProviderOwnField(provider, field))
}

export function canOverridePosField(
	provider: PosProvider,
	entityType: PosEntityType,
	field: string,
): field is PosOwnershipField {
	return getAllowlistedOverrideFields(provider, entityType).includes(
		field as PosOwnershipField,
	)
}

export type PosStoredModifierOptionValue = {
	id: string
	name: string
	price: number
	available: boolean
}

export type PosStoredModifierGroupValue = {
	id: string
	name: string
	min: number
	max: number
	options: PosStoredModifierOptionValue[]
}

export type PosStoredItemValues = {
	name: string
	description: string | null
	price: number
	available: boolean
	category: string
	photo: string | null
	tax: number | null
	modifiers: PosStoredModifierGroupValue[]
}

/** Deterministic SHA-256 hash of a canonical remote item snapshot. */
export function computeRemoteItemHash(item: RemoteItem): string {
	const canonical = {
		name: item.name,
		description: item.description,
		category: item.category,
		price: item.price,
		imageUrl: item.imageUrl ?? null,
		available: item.available,
		modifierGroups: item.modifierGroups.map((group) => ({
			id: group.id ?? null,
			name: group.name,
			min: group.min,
			max: group.max,
			options: group.options.map((option) => ({
				id: option.id ?? null,
				name: option.name,
				price: option.price,
				available: option.available !== false,
			})),
		})),
		variations: item.variations ?? [],
		menus: [...(item.menus ?? [])].sort(),
		allergens: [...(item.allergens ?? [])].sort(),
		alcohol: Boolean(item.alcohol),
		taxRate: item.taxRate ?? null,
	}
	const bytes = new TextEncoder().encode(JSON.stringify(canonical))
	return encodeHexLowerCase(sha256(bytes))
}

/** Extracts normalized local-unit values from a `RemoteItem` for `OrganizationMenuPosLink.posValues`. */
export function extractPosValues(item: RemoteItem): PosStoredItemValues {
	return {
		name: item.name || 'Imported item',
		description: item.description || null,
		price: item.price / 100,
		available: item.available,
		category: item.category || 'Uncategorized',
		photo: item.imageUrl ?? null,
		tax: item.taxRate ?? null,
		modifiers: item.modifierGroups.map((group) => {
			const remoteGroupId = group.id ?? `${item.id}:group:${slug(group.name)}`
			return {
				id: remoteGroupId,
				name: group.name,
				min: group.min,
				max: group.max,
				options: group.options.map((option) => ({
					id: option.id ?? `${remoteGroupId}:option:${slug(option.name)}`,
					name: option.name,
					price: option.price / 100,
					available: option.available !== false,
				})),
			}
		}),
	}
}

export function extractModifierGroupPosValues(group: RemoteModifierGroup) {
	return {
		name: group.name,
		min: group.min,
		max: group.max,
	}
}

export function extractModifierOptionPosValues(option: RemoteOption) {
	return {
		name: option.name,
		price: option.price / 100,
		available: option.available !== false,
	}
}

export function parsePosValues(
	raw: string | null | undefined,
): Record<string, unknown> {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

export function parseOverriddenFields(
	raw: string | null | undefined,
): PosOwnershipField[] {
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed)
			? parsed.filter(
					(entry): entry is PosOwnershipField =>
						typeof entry === 'string' && isPosOwnershipField(entry),
				)
			: []
	} catch {
		return []
	}
}
