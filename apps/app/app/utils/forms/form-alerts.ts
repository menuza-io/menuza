import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	FORM_RESPONSE_NOTIFICATION_TYPE,
	formResponsePath,
} from '@repo/common/form-alerts'

/**
 * What a member hears when a website form gets a response (#142): the form's
 * name, the time (the notification's own) and a link, never an answer. The
 * notification's payload is the organization slug, the form id, its name and a
 * count.
 */
export { FORM_RESPONSE_NOTIFICATION_TYPE }

export function isFormResponseNotificationType(type: string): boolean {
	return type === FORM_RESPONSE_NOTIFICATION_TYPE
}

/** Where the alert leads, relative to the organization. */
export function formAlertPath(formId: string): string {
	return formResponsePath(formId)
}

/** Operator-typed text inside a Markdown subject: no emphasis or links of its own. */
export function plainMarkdown(text: string): string {
	return text.replace(/[*_`[\]()<>\\]/g, '').slice(0, 120)
}

export const FORM_ALERT_COPY: {
	subject: MessageDescriptor
	body: MessageDescriptor
} = {
	subject: msg`**New form response**`,
	body: msg`Open the Mailbox to read it.`,
}

/**
 * The email for the same event, in plain English (a request from the region
 * carries no locale, like the staffing and discount alerts). One response says
 * "New response", several that came in together say "3 new responses".
 */
export const FORM_EMAIL_EYEBROW = 'Website forms'
export const FORM_EMAIL_ACTION = 'Open the Mailbox'
export const FORM_EMAIL_SETTINGS_NOTE =
	'You can change these alerts in your notification settings.'

export function formResponseEmail(formName: string, count: number) {
	const name = formName.trim() || 'your form'
	const headline =
		count > 1 ? `${count} new responses to ${name}` : `New response to ${name}`
	return {
		subject: headline,
		headline,
		detail:
			count > 1
				? 'Several people filled it in. The answers stay in the Mailbox; open it to read them.'
				: 'The answers stay in the Mailbox; open it to read them.',
	}
}
