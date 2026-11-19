import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	GOOGLE_COUPON_MAX,
	GOOGLE_POST_MAX_TEXT,
	GOOGLE_TERMS_MAX,
	GOOGLE_TITLE_MAX,
	type GooglePostProblem,
} from '#app/utils/social/google-post.ts'
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
		google_business: msg`Google`,
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
const googleMaxText = SOCIAL_PLATFORM_RULES.google_business.maxText

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
	google_business: {
		empty: msg`Google needs text or an image.`,
		too_long: msg`Google posts are at most ${googleMaxText} characters.`,
		needs_media: msg`Google needs an image.`,
		too_many_media: msg`Google posts take one image.`,
		too_many_hashtags: msg`Too many hashtags for Google.`,
	},
}

/** Google post rules (#135) beyond the general ones. */
export const GOOGLE_POST_PROBLEM_LABELS: Record<
	GooglePostProblem,
	MessageDescriptor
> = {
	empty: msg`Write some text for the Google post.`,
	too_long: msg`Google posts are at most ${GOOGLE_POST_MAX_TEXT} characters.`,
	has_phone: msg`Google refuses posts with a phone number in the text. Use the Call button instead.`,
	too_many_media: msg`Google posts take one image.`,
	media_type: msg`The Google image must be a JPEG or PNG.`,
	media_too_small: msg`The Google image must be at least 400 by 300 pixels.`,
	title_required: msg`Add a title for the Google post.`,
	title_too_long: msg`The Google title is at most ${GOOGLE_TITLE_MAX} characters.`,
	dates_required: msg`Choose a start and an end date for the Google post.`,
	dates_order: msg`The end of the Google post must not be before its start.`,
	bad_url: msg`The Google post link must start with https://.`,
	button_needs_url: msg`Add the link for the Google button.`,
	coupon_too_long: msg`The coupon code is at most ${GOOGLE_COUPON_MAX} characters.`,
	terms_too_long: msg`The terms are at most ${GOOGLE_TERMS_MAX} characters.`,
	coupon_not_valid_online: msg`This coupon is not active and valid online, so it cannot go in a Google offer.`,
}

/** Our own failure codes stored on a target; Meta's own text shows as is. */
export const SOCIAL_TARGET_ERROR_LABELS: Record<string, MessageDescriptor> = {
	disconnected: msg`This account is no longer connected. Connect it again, then retry.`,
	needs_reauth: msg`Meta no longer accepts this account’s access. Connect it again, then retry.`,
	interrupted: msg`Publishing was interrupted, so the post may already be live. Check the account and send it again only if it is not there.`,
	outcome_unknown: msg`Meta did not confirm this post, so it may already be live. Check the account and send it again only if it is not there.`,
	unexpected: msg`Something went wrong while publishing.`,
	meta_unavailable: msg`Meta did not answer. Try again in a few minutes.`,
	needs_image: msg`Instagram posts need an image.`,
	image_processing_failed: msg`Instagram could not process the image. Use an aspect ratio between 4:5 and 1.91:1.`,
	image_processing_slow: msg`Instagram took too long to process the image. Try again.`,
	mock_refused: msg`The Meta emulator refused this post (it contains #fail).`,
	google_reconnect: msg`This Google profile needs to be reconnected. Reconnect it in Settings, Integrations, then retry.`,
	google_suspended: msg`Google has suspended this profile, so it cannot take posts.`,
	google_not_verified: msg`This Google profile is not verified yet, so it cannot take posts.`,
	google_access_lost: msg`You no longer have access to this Google profile.`,
	google_rejected: msg`Google refused this post.`,
	google_unavailable: msg`Google did not answer. Try again in a few minutes.`,
	google_removed: msg`Google rejected this post after review.`,
}

export function socialTargetError(
	translate: (descriptor: MessageDescriptor) => string,
	error: string | null,
): string | null {
	if (!error) return null
	if (error.startsWith('google_invalid:')) {
		const first = error.slice('google_invalid:'.length).split(',')[0]
		const label = GOOGLE_POST_PROBLEM_LABELS[first as GooglePostProblem]
		return label ? translate(label) : error
	}
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
			? ((platform === 'google_business'
					? GOOGLE_POST_PROBLEM_LABELS[problem as GooglePostProblem]
					: undefined) ??
				SOCIAL_PROBLEM_LABELS[platform as SocialPlatform]?.[
					problem as SocialPostProblem
				])
			: undefined
		const label: MessageDescriptor =
			platformLabel ??
			SOCIAL_FORM_ERROR_LABELS[code] ??
			SOCIAL_FORM_ERROR_FALLBACK
		return { message: translate(label) }
	})
}
