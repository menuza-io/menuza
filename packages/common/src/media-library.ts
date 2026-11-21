/**
 * Media library organization rules (#147): tags, archive and photo versions.
 * Pure: the App reads and writes rows, this decides what is allowed.
 *
 * - A tag is lowercase, 1 to 32 characters, and an asset has at most 20
 *   (`bad_tag`, `too_many_tags`).
 * - `featured` is reserved: the website and the hero video (#301) prefer
 *   photos that carry it.
 * - A version chain (studio edit of an original) never loops and never leaves
 *   the organization (`invalid_parent`).
 * - Only `ready` assets can be attached anywhere (`asset_not_ready`).
 */

export const FEATURED_TAG = 'featured'
export const MAX_TAG_LENGTH = 32
export const MAX_TAGS_PER_ASSET = 20
/** A bulk change touches at most this many assets in one request. */
export const MAX_BULK_ASSETS = 100
/** A version chain is walked at most this deep before it counts as a loop. */
export const MAX_VERSION_DEPTH = 50

export const MEDIA_STATUSES = ['ready', 'processing', 'draft'] as const
export type MediaStatus = (typeof MEDIA_STATUSES)[number]

export type MediaLibraryError =
	| 'bad_tag'
	| 'too_many_tags'
	| 'asset_in_use'
	| 'asset_not_ready'
	| 'invalid_parent'

// Letters and digits of any script, then letters, digits, spaces, `-` and `_`.
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u

/** Lowercase, trimmed, inner whitespace collapsed; null when it is not a tag. */
export function normalizeTag(input: unknown): string | null {
	if (typeof input !== 'string') return null
	const tag = input.trim().replace(/\s+/gu, ' ').toLowerCase()
	if (tag.length < 1 || tag.length > MAX_TAG_LENGTH) return null
	return TAG_PATTERN.test(tag) ? tag : null
}

/** A comma or line separated list of tags, normalized and de-duplicated. */
export function parseTagList(
	input: unknown,
): { ok: true; tags: string[] } | { ok: false; error: 'bad_tag' } {
	// Each entry may itself be a comma or line separated list (a form field).
	const parts = (
		input == null ? [] : Array.isArray(input) ? input : [input]
	).flatMap((entry) =>
		typeof entry === 'string' ? entry.split(/[,\n]/u) : [entry],
	)
	const tags: string[] = []
	for (const part of parts) {
		if (typeof part === 'string' && part.trim() === '') continue
		const tag = normalizeTag(part)
		if (!tag) return { ok: false, error: 'bad_tag' }
		if (!tags.includes(tag)) tags.push(tag)
	}
	return { ok: true, tags }
}

/** The tags an asset would have after adding some; `too_many_tags` past 20. */
export function addTags(
	current: readonly string[],
	added: readonly string[],
): { ok: true; tags: string[] } | { ok: false; error: 'too_many_tags' } {
	const tags = [...current]
	for (const tag of added) if (!tags.includes(tag)) tags.push(tag)
	if (tags.length > MAX_TAGS_PER_ASSET) {
		return { ok: false, error: 'too_many_tags' }
	}
	return { ok: true, tags }
}

/**
 * Whether making `parentId` the original of `assetId` is allowed: not itself,
 * and not an asset that is already a version of `assetId` (directly or
 * further down the chain). `parentOf` maps asset id to its current original.
 */
export function canSetParent(
	assetId: string,
	parentId: string | null,
	parentOf: ReadonlyMap<string, string | null>,
): boolean {
	if (parentId === null) return true
	if (parentId === assetId) return false
	let cursor: string | null | undefined = parentId
	for (let depth = 0; cursor && depth < MAX_VERSION_DEPTH; depth += 1) {
		if (cursor === assetId) return false
		cursor = parentOf.get(cursor)
	}
	return !cursor
}

/** The id of the root original of a chain (the asset itself when it has none). */
export function chainRoot(
	assetId: string,
	parentOf: ReadonlyMap<string, string | null>,
): string {
	let current = assetId
	for (let depth = 0; depth < MAX_VERSION_DEPTH; depth += 1) {
		const parent = parentOf.get(current)
		if (!parent) return current
		current = parent
	}
	return current
}

/**
 * What a reference to an asset blocks. A dish photo, the website (a page, its
 * published copy or SEO image), the logo and the site icon keep an asset out
 * of the archive: the object itself stays served either way, but archiving
 * what the live site shows would hide it from the people who maintain it.
 * Notes, comments, social posts and email templates do not block.
 */
export const ARCHIVE_BLOCKING_REFERENCE_TYPES = [
	'page',
	'menu-item',
	'menu-option',
	'logo',
	'site-icon',
	'site-chrome',
] as const

export function blocksArchive(referenceType: string): boolean {
	return (ARCHIVE_BLOCKING_REFERENCE_TYPES as readonly string[]).includes(
		referenceType,
	)
}

export function isAttachable(status: string): boolean {
	return status === 'ready'
}
