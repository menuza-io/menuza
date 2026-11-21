import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

/**
 * What the person who scheduled a publish is told (#180). The in-app
 * notification carries the kind, the organization slug and the page title
 * (the operator's own content); the words are written here.
 */

export const WEBSITE_ALERT_TYPES = {
	live: 'website-publish-live',
	failed: 'website-publish-failed',
	// "Make a video from my photos" (#301): the clip is ready to preview, or could not be made.
	heroVideoReady: 'hero-video-ready',
	heroVideoFailed: 'hero-video-failed',
} as const

export type WebsiteAlertKind = keyof typeof WEBSITE_ALERT_TYPES

export function websiteAlertKindFromNotificationType(
	type: unknown,
): WebsiteAlertKind | null {
	if (type === WEBSITE_ALERT_TYPES.live) return 'live'
	if (type === WEBSITE_ALERT_TYPES.failed) return 'failed'
	if (type === WEBSITE_ALERT_TYPES.heroVideoReady) return 'heroVideoReady'
	if (type === WEBSITE_ALERT_TYPES.heroVideoFailed) return 'heroVideoFailed'
	return null
}

export function websiteAlertCopy(
	kind: WebsiteAlertKind,
	title: string | null,
	_: (descriptor: MessageDescriptor) => string,
) {
	const name = title?.trim() || null
	if (kind === 'heroVideoReady') {
		return {
			subject: _(msg`Your hero video is ready to preview`),
			body: _(
				msg`Watch it, then accept it to use it on your site. Your current hero stays until you do.`,
			),
		}
	}
	if (kind === 'heroVideoFailed') {
		return {
			subject: _(msg`Your hero video could not be made`),
			body: _(
				msg`Nothing on your site changed. Try again, or pick other photos.`,
			),
		}
	}
	if (kind === 'live') {
		return {
			subject: name
				? _(msg`**${name}** is live`)
				: _(msg`Your scheduled website change is live`),
			body: _(msg`It went live at the time you chose.`),
		}
	}
	return {
		subject: name
			? _(msg`**${name}** could not go live`)
			: _(msg`Your scheduled website change could not go live`),
		body: _(
			msg`We tried three times and stopped. Open the page, check it and schedule it again, or publish it now.`,
		),
	}
}

export function websiteAlertPath(pageId: string | null) {
	return pageId
		? `/website/pages/${encodeURIComponent(pageId)}`
		: '/website/pages'
}
