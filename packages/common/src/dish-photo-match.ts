/**
 * Bulk dish photos (#316). Pure: the App runs the model and applies pairs;
 * this decides the limits, reads file names and proposes matches.
 *
 * - A proposal is only a proposal: nothing is attached to a dish until the
 *   operator confirms the pair.
 * - A dish that already has a photo is `replace: true` and starts unticked.
 * - A dish is offered to one photo only; a photo to one dish only.
 */

import { hasLowResolution } from './photo-quality.ts'

/** Photos in one batch (a zip counts by the images inside it). */
export const BULK_PHOTO_MAX_FILES = 100
/** One image, as for a single library upload. */
export const BULK_PHOTO_MAX_FILE_BYTES = 10 * 1024 * 1024
/** All images of one batch together. */
export const BULK_PHOTO_MAX_TOTAL_BYTES = 400 * 1024 * 1024
/** A zip file itself. */
export const BULK_PHOTO_MAX_ZIP_BYTES = 400 * 1024 * 1024
export const BULK_PHOTO_ALLOWED_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
	'image/avif',
] as const

export const BULK_PHOTO_EXTENSION_TYPES: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	avif: 'image/avif',
}

export type BulkPhotoRefusal =
	'not_an_image' | 'too_large' | 'too_many_files' | 'batch_too_large' | 'empty'

export function imageTypeFromName(fileName: string): string | null {
	const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase()
	return extension ? (BULK_PHOTO_EXTENSION_TYPES[extension] ?? null) : null
}

/** Checks a set of files (name, size) against the batch limits. */
export function checkBulkPhotoBatch(
	files: ReadonlyArray<{ name: string; size: number; type?: string }>,
): { ok: true } | { ok: false; error: BulkPhotoRefusal; fileName?: string } {
	if (files.length === 0) return { ok: false, error: 'empty' }
	if (files.length > BULK_PHOTO_MAX_FILES)
		return { ok: false, error: 'too_many_files' }
	let total = 0
	for (const file of files) {
		const type = file.type || imageTypeFromName(file.name)
		if (
			!type ||
			!(BULK_PHOTO_ALLOWED_TYPES as readonly string[]).includes(type)
		)
			return { ok: false, error: 'not_an_image', fileName: file.name }
		if (file.size <= 0)
			return { ok: false, error: 'not_an_image', fileName: file.name }
		if (file.size > BULK_PHOTO_MAX_FILE_BYTES)
			return { ok: false, error: 'too_large', fileName: file.name }
		total += file.size
	}
	if (total > BULK_PHOTO_MAX_TOTAL_BYTES)
		return { ok: false, error: 'batch_too_large' }
	return { ok: true }
}

/** Lowercase, no accents or Arabic marks, letters and digits only, one space. */
export function normalizeMatchText(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/[̀-ًͯ-ٰٟـ]/g, '')
		.replace(/[أإآٱ]/g, 'ا')
		.replace(/ى/g, 'ي')
		.replace(/ة/g, 'ه')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
}

const CAMERA_NOISE =
	/^(img|dsc|dscn|dscf|pxl|photo|image|pic|picture|screenshot|whatsapp|copy|final|edit|edited|new|v\d+)$/i

/**
 * The words of a file name that might name a dish: no extension, no camera
 * prefixes ("IMG_2041"), no bare numbers, no copy markers.
 */
export function fileNameWords(fileName: string): string[] {
	const base = fileName
		.replace(/^.*[\\/]/, '')
		.replace(/\.[a-z0-9]{2,5}$/i, '')
		// "(2)" and "copy 3" are copy markers, not part of a dish name.
		.replace(/\s*\(\d+\)\s*$/, '')
	// camelCase and snake_case read as separate words.
	const spaced = base.replace(/([a-z])([A-Z])/g, '$1 $2')
	return normalizeMatchText(spaced)
		.split(' ')
		.filter(
			(word) =>
				// A short number can belong to the name ("Combo 12"); a long one is
				// a camera counter.
				!/^\d{4,}$/.test(word) && !CAMERA_NOISE.test(word) && word.length > 1,
		)
}

function stem(word: string): string {
	if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
	if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses'))
		return word.slice(0, -2)
	if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1)
	return word
}

export type MatchDish = {
	id: string
	/** The dish's name in each language it has; any of them may match. */
	names: readonly string[]
	hasPhoto: boolean
}

/**
 * How well a name (file name, or what the model saw) fits a dish, 0 to 1.
 * 1 is the whole dish name and nothing else; a share of the dish's words
 * found in the text scores in between; one shared word out of several is low.
 */
export function nameMatchScore(
	words: readonly string[],
	dish: MatchDish,
): number {
	if (words.length === 0) return 0
	const fileWords = new Set(words.map(stem))
	let best = 0
	for (const name of dish.names) {
		const dishWords = normalizeMatchText(name)
			.split(' ')
			.filter(Boolean)
			.map(stem)
		if (dishWords.length === 0) continue
		const hits = dishWords.filter((word) => fileWords.has(word)).length
		if (hits === 0) continue
		const coverage = hits / dishWords.length
		// Extra words in the file name count against it a little.
		const extras = [...fileWords].filter(
			(word) => !dishWords.includes(word),
		).length
		const exact = coverage === 1 && extras === 0
		const score = exact ? 1 : coverage * 0.9 - Math.min(0.25, extras * 0.05)
		best = Math.max(best, score)
	}
	return Math.max(0, Math.min(1, best))
}

export type MatchConfidence = 'high' | 'medium' | 'low'

export function matchConfidence(score: number): MatchConfidence | null {
	if (score >= 0.85) return 'high'
	if (score >= 0.6) return 'medium'
	if (score >= 0.35) return 'low'
	return null
}

export type BulkPhotoInput = {
	assetId: string
	fileName: string | null
	width: number | null
	height: number | null
	/** A hash of the file's bytes; equal hashes are duplicates. */
	contentHash?: string | null
	/** What the vision adapter saw; `null` when it did not run or failed. */
	vision?: {
		looksLikeFood: boolean
		/** A short guess of the dish ("margherita pizza"). */
		label?: string | null
		/** A 0 to 100 quality score when #145 has one. */
		qualityScore?: number | null
	} | null
	/** An existing #145 score, used when the model did not run. */
	qualityScore?: number | null
}

export type BulkPhotoFlag = 'not_food' | 'too_small' | 'duplicate' | 'weak'

export type BulkPhotoProposal = {
	assetId: string
	itemId: string | null
	confidence: MatchConfidence | null
	score: number
	/** The dish already has a photo: the pair needs the operator's "Replace?". */
	replace: boolean
	flags: BulkPhotoFlag[]
}

/**
 * Proposes dish matches by file name and by what the model saw. Nothing is
 * assigned: the result feeds the review grid. Greedy by score, so the best
 * pairs win and a dish is offered once.
 */
export function proposeBulkPhotoMatches(
	photos: readonly BulkPhotoInput[],
	dishes: readonly MatchDish[],
): BulkPhotoProposal[] {
	const flags = new Map<string, BulkPhotoFlag[]>()
	const seenHashes = new Map<string, string>()
	for (const photo of photos) {
		const list: BulkPhotoFlag[] = []
		if (photo.vision && !photo.vision.looksLikeFood) list.push('not_food')
		if (hasLowResolution(photo.width, photo.height)) list.push('too_small')
		const score = photo.vision?.qualityScore ?? photo.qualityScore
		if (typeof score === 'number' && score < 50) list.push('weak')
		if (photo.contentHash) {
			if (seenHashes.has(photo.contentHash)) list.push('duplicate')
			else seenHashes.set(photo.contentHash, photo.assetId)
		}
		flags.set(photo.assetId, list)
	}

	type Candidate = { assetId: string; itemId: string; score: number }
	const candidates: Candidate[] = []
	for (const photo of photos) {
		// A photo that is not food is never proposed for a dish.
		if (flags.get(photo.assetId)?.includes('not_food')) continue
		const nameWords = photo.fileName ? fileNameWords(photo.fileName) : []
		const visionWords = photo.vision?.label
			? fileNameWords(photo.vision.label)
			: []
		for (const dish of dishes) {
			const byName = nameMatchScore(nameWords, dish)
			// What a model saw is a weaker signal than a name someone typed.
			const byVision = nameMatchScore(visionWords, dish) * 0.8
			const score = Math.max(byName, byVision)
			if (matchConfidence(score)) {
				candidates.push({ assetId: photo.assetId, itemId: dish.id, score })
			}
		}
	}
	candidates.sort(
		(a, b) =>
			b.score - a.score ||
			a.assetId.localeCompare(b.assetId) ||
			a.itemId.localeCompare(b.itemId),
	)
	const usedAssets = new Set<string>()
	const usedDishes = new Set<string>()
	const chosen = new Map<string, Candidate>()
	for (const candidate of candidates) {
		if (usedAssets.has(candidate.assetId) || usedDishes.has(candidate.itemId))
			continue
		// A duplicate of an earlier photo does not compete for a dish.
		if (flags.get(candidate.assetId)?.includes('duplicate')) continue
		usedAssets.add(candidate.assetId)
		usedDishes.add(candidate.itemId)
		chosen.set(candidate.assetId, candidate)
	}
	const dishById = new Map(dishes.map((dish) => [dish.id, dish]))
	return photos.map((photo) => {
		const match = chosen.get(photo.assetId)
		const dish = match ? dishById.get(match.itemId) : undefined
		return {
			assetId: photo.assetId,
			itemId: match?.itemId ?? null,
			confidence: match ? matchConfidence(match.score) : null,
			score: match ? Math.round(match.score * 100) / 100 : 0,
			replace: Boolean(dish?.hasPhoto),
			flags: flags.get(photo.assetId) ?? [],
		}
	})
}

export type BulkPhotoPair = {
	assetId: string
	itemId: string
	/** The operator ticked "Replace?" for a dish that already has a photo. */
	replace: boolean
}

/**
 * The pairs the operator confirmed, checked against the dishes as they are
 * now: a dish with a photo needs `replace`, a dish or photo used twice is
 * refused whole (no half-applied batch).
 */
export function checkBulkPhotoPairs(
	pairs: readonly BulkPhotoPair[],
	dishHasPhoto: ReadonlyMap<string, boolean>,
):
	| { ok: true }
	| {
			ok: false
			error:
				'empty' | 'duplicate_pair' | 'unknown_dish' | 'replace_not_confirmed'
			itemId?: string
	  } {
	if (pairs.length === 0) return { ok: false, error: 'empty' }
	const assets = new Set<string>()
	const items = new Set<string>()
	for (const pair of pairs) {
		if (assets.has(pair.assetId) || items.has(pair.itemId))
			return { ok: false, error: 'duplicate_pair', itemId: pair.itemId }
		assets.add(pair.assetId)
		items.add(pair.itemId)
		const hasPhoto = dishHasPhoto.get(pair.itemId)
		if (hasPhoto === undefined)
			return { ok: false, error: 'unknown_dish', itemId: pair.itemId }
		if (hasPhoto && pair.replace !== true)
			return { ok: false, error: 'replace_not_confirmed', itemId: pair.itemId }
	}
	return { ok: true }
}
