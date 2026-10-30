import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	SOCIAL_MAX_MEDIA,
	SOCIAL_PLATFORM_RULES,
	type SocialPlatform,
	type SocialPostProblem,
	type SocialPostStatus,
	type SocialTargetStatus,
} from '#app/utils/social/platforms.ts'

export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, MessageDescriptor> =
	{
		facebook: msg`Facebook`,
		instagram: msg`Instagram`,
	}

export const SOCIAL_POST_STATUS_LABELS: Record<
	SocialPostStatus,
	MessageDescriptor
> = {
	draft: msg`Draft`,
	scheduled: msg`Scheduled`,
	publishing: msg`Publishing`,
	published: msg`Published`,
	partial: msg`Partly published`,
	failed: msg`Failed`,
}

export const SOCIAL_TARGET_STATUS_LABELS: Record<
	SocialTargetStatus,
	MessageDescriptor
> = {
	pending: msg`Waiting`,
	publishing: msg`Publishing`,
	published: msg`Published`,
	failed: msg`Failed`,
}

const instagramMaxText = SOCIAL_PLATFORM_RULES.instagram.maxText
const instagramMaxHashtags = SOCIAL_PLATFORM_RULES.instagram.maxHashtags ?? 30

export const SOCIAL_PROBLEM_LABELS: Record<
	SocialPlatform,
	Record<SocialPostProblem, MessageDescriptor>
> = {
	facebook: {
		empty: msg`Facebook needs text or an image.`,
		too_long: msg`The text is too long for Facebook.`,
		needs_media: msg`Facebook needs an image.`,
		too_many_media: msg`Facebook takes at most ${SOCIAL_MAX_MEDIA} images.`,
		too_many_hashtags: msg`Too many hashtags for Facebook.`,
	},
	instagram: {
		empty: msg`Instagram needs an image.`,
		too_long: msg`Instagram captions are at most ${instagramMaxText} characters.`,
		needs_media: msg`Instagram needs at least one image.`,
		too_many_media: msg`Instagram takes at most ${SOCIAL_MAX_MEDIA} images.`,
		too_many_hashtags: msg`Instagram allows at most ${instagramMaxHashtags} hashtags.`,
	},
}

/** Our own failure codes stored on a target; Meta's own text shows as is. */
export const SOCIAL_TARGET_ERROR_LABELS: Record<string, MessageDescriptor> = {
	disconnected: msg`This account is no longer connected. Connect it again, then retry.`,
	needs_reauth: msg`Meta no longer accepts this account’s access. Connect it again, then retry.`,
	interrupted: msg`Publishing was interrupted. Check the account before retrying: the post may already be live.`,
	unexpected: msg`Something went wrong while publishing.`,
	meta_unavailable: msg`Meta did not answer. Try again in a few minutes.`,
	needs_image: msg`Instagram posts need an image.`,
	image_processing_failed: msg`Instagram could not process the image. Use an aspect ratio between 4:5 and 1.91:1.`,
	image_processing_slow: msg`Instagram took too long to process the image. Try again.`,
	mock_refused: msg`The Meta emulator refused this post (it contains #fail).`,
}

export function socialTargetError(
	translate: (descriptor: MessageDescriptor) => string,
	error: string | null,
): string | null {
	if (!error) return null
	const label = SOCIAL_TARGET_ERROR_LABELS[error]
	return label ? translate(label) : error
}

/** Form codes from the composer schema. */
export const SOCIAL_FORM_ERROR_LABELS: Record<string, MessageDescriptor> = {
	accounts_required: msg`Choose at least one account.`,
	schedule_required: msg`Choose a date and time.`,
	schedule_future: msg`Choose a time at least a minute from now.`,
	schedule_too_far: msg`Choose a time within the next year.`,
	too_long: msg`The text is too long.`,
	too_many_media: msg`Attach at most ${SOCIAL_MAX_MEDIA} images.`,
	not_editable: msg`This post has started publishing and can no longer be edited.`,
}

export const SOCIAL_FORM_ERROR_FALLBACK = msg`Check this field.`

export function socialFormErrors(
	translate: (descriptor: MessageDescriptor) => string,
	errors: string[] | undefined,
): Array<{ message: string }> | undefined {
	return errors?.map((code) => {
		const [platform, problem] = code.split(':') as [string, string | undefined]
		const platformLabel = problem
			? SOCIAL_PROBLEM_LABELS[platform as SocialPlatform]?.[
					problem as SocialPostProblem
				]
			: undefined
		const label: MessageDescriptor =
			platformLabel ??
			SOCIAL_FORM_ERROR_LABELS[code] ??
			SOCIAL_FORM_ERROR_FALLBACK
		return { message: translate(label) }
	})
}
