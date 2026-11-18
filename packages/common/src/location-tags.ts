/**
 * Location tags (#374): pure rules shared by the App's tag pages, the CSV
 * import and the report filter. No I/O.
 */

/** Tags one organization can have. */
export const MAX_LOCATION_TAGS = 50
export const LOCATION_TAG_NAME_MAX_LENGTH = 40

export type LocationTagNameError = 'name_required' | 'name_too_long'

/** The name as shown: trimmed, inner whitespace collapsed to single spaces. */
export function normalizeLocationTagName(name: string): string {
	return name.replace(/\s+/g, ' ').trim()
}

/** What makes two tag names the same: the normalized name in lower case. */
export function locationTagNameKey(name: string): string {
	return normalizeLocationTagName(name).toLocaleLowerCase('en')
}

export function validateLocationTagName(
	name: string,
):
	| { ok: true; name: string; key: string }
	| { ok: false; error: LocationTagNameError } {
	const normalized = normalizeLocationTagName(name)
	if (normalized.length === 0) return { ok: false, error: 'name_required' }
	if (normalized.length > LOCATION_TAG_NAME_MAX_LENGTH)
		return { ok: false, error: 'name_too_long' }
	return { ok: true, name: normalized, key: locationTagNameKey(normalized) }
}

/**
 * Whether a tag list can take `additional` more tags, counting by name key so
 * tags the list already has do not count again.
 */
export function tagLimitAllows(
	existingKeys: readonly string[],
	newKeys: readonly string[],
): boolean {
	const all = new Set([...existingKeys, ...newKeys])
	return all.size <= MAX_LOCATION_TAGS
}
