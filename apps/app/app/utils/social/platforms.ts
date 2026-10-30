/**
 * Social posting rules shared by the composer (browser) and the server. No
 * I/O and no UI strings: problems are codes, translated in
 * `components/social/social-labels.ts`.
 */

export const SOCIAL_PLATFORMS = ['facebook', 'instagram'] as const
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]

export function isSocialPlatform(value: unknown): value is SocialPlatform {
	return SOCIAL_PLATFORMS.includes(value as SocialPlatform)
}

export const SOCIAL_POST_STATUSES = [
	'draft',
	'scheduled',
	'publishing',
	'published',
	'partial',
	'failed',
] as const
export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number]

export const SOCIAL_TARGET_STATUSES = [
	'pending',
	'publishing',
	'published',
	'failed',
] as const
export type SocialTargetStatus = (typeof SOCIAL_TARGET_STATUSES)[number]

/** A media library image attached to a post. */
export type SocialPostMedia = {
	mediaId: string
	url: string
	altText: string | null
}

export const SOCIAL_MAX_MEDIA = 10

export const SOCIAL_PLATFORM_RULES: Record<
	SocialPlatform,
	{ maxText: number; requiresMedia: boolean; maxHashtags: number | null }
> = {
	facebook: { maxText: 63_206, requiresMedia: false, maxHashtags: null },
	instagram: { maxText: 2_200, requiresMedia: true, maxHashtags: 30 },
}

/** The longest post any platform accepts. */
export const SOCIAL_MAX_TEXT = Math.max(
	...SOCIAL_PLATFORMS.map(
		(platform) => SOCIAL_PLATFORM_RULES[platform].maxText,
	),
)

export type SocialPostProblem =
	'empty' | 'too_long' | 'needs_media' | 'too_many_media' | 'too_many_hashtags'

export function countHashtags(body: string): number {
	return body.match(/(^|\s)#[^\s#]+/gu)?.length ?? 0
}

/** What keeps a post from going to each of these platforms. */
export function socialPostProblems(input: {
	body: string
	mediaCount: number
	platforms: readonly SocialPlatform[]
}): Array<{ platform: SocialPlatform; problem: SocialPostProblem }> {
	const problems: Array<{
		platform: SocialPlatform
		problem: SocialPostProblem
	}> = []
	const body = input.body.trim()
	const length = [...body].length
	for (const platform of new Set(input.platforms)) {
		const rules = SOCIAL_PLATFORM_RULES[platform]
		if (!body && input.mediaCount === 0) {
			problems.push({ platform, problem: 'empty' })
		}
		if (length > rules.maxText) problems.push({ platform, problem: 'too_long' })
		if (rules.requiresMedia && input.mediaCount === 0) {
			problems.push({ platform, problem: 'needs_media' })
		}
		if (input.mediaCount > SOCIAL_MAX_MEDIA) {
			problems.push({ platform, problem: 'too_many_media' })
		}
		if (rules.maxHashtags !== null && countHashtags(body) > rules.maxHashtags) {
			problems.push({ platform, problem: 'too_many_hashtags' })
		}
	}
	return problems
}

/** Summarizes target outcomes into the post's status. */
export function settledPostStatus(
	targets: ReadonlyArray<{ status: string }>,
): 'published' | 'partial' | 'failed' {
	const published = targets.filter((t) => t.status === 'published').length
	if (published === targets.length && published > 0) return 'published'
	return published > 0 ? 'partial' : 'failed'
}
