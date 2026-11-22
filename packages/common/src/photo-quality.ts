/**
 * Dish photo quality (#145). Pure: the App runs the model and stores the
 * result, this fixes the vocabulary, the numbers and how a model answer is
 * trusted.
 *
 * - A score is 0 to 100 and advisory: it never blocks saving or publishing.
 * - Issues come from a fixed list; anything else a model says is dropped.
 * - A short side under 800 px is `low_resolution` on its own, without a model.
 * - A model answer that does not parse is no answer: the photo stays unscored
 *   (no penalty) and the job retries once.
 */

import { z } from 'zod'

export const PHOTO_QUALITY_ISSUE_KEYS = [
	'too_dark',
	'blurry',
	'dish_cut_off',
	'low_resolution',
	'not_food',
] as const
export type PhotoQualityIssue = (typeof PHOTO_QUALITY_ISSUE_KEYS)[number]

/** Under this short side (px) a photo is flagged without any model. */
export const PHOTO_MIN_SHORT_SIDE = 800
/** A dish whose primary photo scores under this is a weak dish photo. */
export const WEAK_PHOTO_SCORE = 50
/** A failed analysis is retried once: two attempts in all. */
export const PHOTO_QUALITY_MAX_ATTEMPTS = 2
/** Analyses one organization may use per rolling day. */
export const PHOTO_QUALITY_DAILY_LIMIT = 200
/** Backfill of existing images: at most this many analyses per job call. */
export const PHOTO_QUALITY_BATCH_SIZE = 10

export function isPhotoQualityIssue(
	value: unknown,
): value is PhotoQualityIssue {
	return (
		typeof value === 'string' &&
		(PHOTO_QUALITY_ISSUE_KEYS as readonly string[]).includes(value)
	)
}

/** The issue keys of a stored JSON array; unknown keys are dropped. */
export function parsePhotoQualityIssues(raw: unknown): PhotoQualityIssue[] {
	let value = raw
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw)
		} catch {
			return []
		}
	}
	if (!Array.isArray(value)) return []
	const issues: PhotoQualityIssue[] = []
	for (const entry of value) {
		if (isPhotoQualityIssue(entry) && !issues.includes(entry))
			issues.push(entry)
	}
	return issues
}

export function hasLowResolution(
	width: number | null | undefined,
	height: number | null | undefined,
): boolean {
	if (!width || !height) return false
	return Math.min(width, height) < PHOTO_MIN_SHORT_SIDE
}

const ModelOutputSchema = z.object({
	score: z.number().finite(),
	issues: z.array(z.string()).max(20).default([]),
})

/**
 * Reads what the vision model said (text or an already parsed object).
 * Returns `null` for anything malformed, so the caller leaves the photo
 * unscored instead of guessing.
 */
export function parsePhotoQualityModelOutput(
	raw: unknown,
): { score: number; issues: PhotoQualityIssue[] } | null {
	let value = raw
	if (typeof raw === 'string') {
		const start = raw.indexOf('{')
		const end = raw.lastIndexOf('}')
		if (start === -1 || end <= start) return null
		try {
			value = JSON.parse(raw.slice(start, end + 1))
		} catch {
			return null
		}
	}
	const parsed = ModelOutputSchema.safeParse(value)
	if (!parsed.success) return null
	const issues: PhotoQualityIssue[] = []
	for (const entry of parsed.data.issues) {
		if (isPhotoQualityIssue(entry) && !issues.includes(entry))
			issues.push(entry)
	}
	return {
		score: Math.round(Math.min(100, Math.max(0, parsed.data.score))),
		issues,
	}
}

export type PhotoQualityResult = {
	/** `null` when no model answered: the photo is unscored. */
	score: number | null
	issues: PhotoQualityIssue[]
}

/**
 * Joins the model's answer (if any) with the facts that need no model. A
 * small photo always carries `low_resolution` and can never score 50 or more;
 * without a model answer the score stays `null`.
 */
export function combinePhotoQuality(input: {
	width: number | null | undefined
	height: number | null | undefined
	model: { score: number; issues: PhotoQualityIssue[] } | null
}): PhotoQualityResult {
	const issues = new Set<PhotoQualityIssue>(input.model?.issues ?? [])
	const small = hasLowResolution(input.width, input.height)
	if (small) issues.add('low_resolution')
	let score = input.model ? input.model.score : null
	if (score !== null && small) score = Math.min(score, WEAK_PHOTO_SCORE - 1)
	return {
		score,
		issues: PHOTO_QUALITY_ISSUE_KEYS.filter((k) => issues.has(k)),
	}
}

/**
 * A weak photo: scored under 50, or too small (which needs no score). An
 * unscored photo with no known issue is never weak.
 */
export function isWeakPhoto(input: {
	score: number | null | undefined
	issues: readonly PhotoQualityIssue[]
}): boolean {
	if (input.issues.includes('low_resolution')) return true
	return typeof input.score === 'number' && input.score < WEAK_PHOTO_SCORE
}

/** The `?issues=` value the photo studio opens with. */
export function formatStudioIssues(
	issues: readonly PhotoQualityIssue[],
): string {
	return issues.join(',')
}

/** Reads the studio's `?issues=` value; unknown keys are dropped. */
export function parseStudioIssues(value: string | null | undefined) {
	return parsePhotoQualityIssues(
		value
			? value
					.split(',')
					.map((entry) => entry.trim())
					.filter(Boolean)
			: [],
	)
}

const STUDIO_ISSUE_DIRECTIONS: Partial<Record<PhotoQualityIssue, string>> = {
	too_dark: 'Brighten the photo with soft, even light.',
	blurry: 'Make the dish sharp and in focus.',
	dish_cut_off:
		'Show the whole dish inside the frame with some space around it.',
	low_resolution:
		'Give the photo fine detail and a clean, high-resolution look.',
}

/**
 * The studio's "Extra direction" text for the issues found (#145). It goes to
 * the image model, so it stays English; the operator can edit it. At most 500
 * characters, the studio's own limit.
 */
export function studioInstructionsForIssues(
	issues: readonly PhotoQualityIssue[],
): string {
	return issues
		.flatMap((issue) => {
			const direction = STUDIO_ISSUE_DIRECTIONS[issue]
			return direction ? [direction] : []
		})
		.join(' ')
		.slice(0, 500)
}
