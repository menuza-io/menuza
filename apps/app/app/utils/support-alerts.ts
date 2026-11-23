import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

/**
 * What a restaurant is told when Menuza support replies to a request (#406).
 * The notification carries the organization slug and the request id; the words
 * are written here, so the reply itself never travels in a notification, an
 * email or a push.
 */

export const SUPPORT_REPLY_NOTIFICATION_TYPE = 'support-reply'

export function isSupportReplyNotificationType(type: unknown): boolean {
	return type === SUPPORT_REPLY_NOTIFICATION_TYPE
}

export const SUPPORT_REPLY_COPY: {
	subject: MessageDescriptor
	body: MessageDescriptor
} = {
	subject: msg`Menuza support **replied** to your request`,
	body: msg`Open Support to read the reply and answer.`,
}

export function supportRequestPath(requestId: string) {
	return `/support?request=${encodeURIComponent(requestId)}`
}

/** Plain English for the email: a job has no request language. */
export const SUPPORT_REPLY_EMAIL = {
	eyebrow: 'Support',
	subject: 'Menuza support replied to your request',
	headline: 'Menuza support replied to your request',
	detail: 'Open Support to read the reply and answer.',
	actionLabel: 'Open the request',
} as const
