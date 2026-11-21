import { buildOperatorLink } from './links.ts'
import { z } from 'zod'

import { parseLocalizedString } from './site-locales.ts'

/**
 * Form response alerts (#142). tenant-api tells the App that a form got a new
 * response; the App owns the members, their notification choices and their
 * email addresses. The event is strict and carries ids and a count only: never
 * a value, a name or a contact. The form's name is operator-authored copy, not
 * a guest answer.
 */

/** The App route that turns the event into notifications and emails. */
export const FORM_NOTIFY_PATH = '/resources/forms/notify'

/** `Notification.type` written for a new response. */
export const FORM_RESPONSE_NOTIFICATION_TYPE = 'form-response'

/** Workflow id of the member's channel choices (in-app, email). */
export const FORM_RESPONSE_WORKFLOW = 'form-response-workflow'

/** At most one email per form per member in this window (#142). */
export const FORM_ALERT_EMAIL_WINDOW_MS = 10 * 60 * 1000

const idSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Invalid id')

/** Who is notified: every member with website access, or chosen members. */
export const formNotifySchema = z.union([
	z.object({ mode: z.literal('all') }).strict(),
	z
		.object({
			mode: z.literal('members'),
			userIds: z.array(idSchema).max(200),
		})
		.strict(),
])
export type FormNotify = z.infer<typeof formNotifySchema>

export function parseFormNotify(raw: unknown): FormNotify {
	const parsed = formNotifySchema.safeParse(raw)
	return parsed.success ? parsed.data : { mode: 'all' }
}

export const formResponseEventSchema = z
	.object({
		orgId: idSchema,
		/** The outbox row: a retried delivery carries the same id. */
		eventId: idSchema,
		formId: idSchema,
		formName: z.string().max(200),
		count: z.number().int().min(1).max(10_000),
		/** When the response arrived (ms since epoch). */
		at: z.number().int().nonnegative(),
		notify: formNotifySchema,
		/** Restricted forms notify without answers; informational for the App. */
		restricted: z.boolean(),
	})
	.strict()
export type FormResponseEvent = z.infer<typeof formResponseEventSchema>

/** What the App answers: counts only. */
export const formResponseResultSchema = z
	.object({
		inApp: z.number().int().nonnegative(),
		emailed: z.number().int().nonnegative(),
		skipped: z.string().max(64).optional(),
	})
	.strict()
export type FormResponseResult = z.infer<typeof formResponseResultSchema>

/**
 * A form name as plain text: names are stored as localized JSON on a
 * multilingual site, and an alert is one language, so the English name (or the
 * first language there is) is used.
 */
export function plainFormName(name: string): string {
	const localized = parseLocalizedString(name)
	const text =
		localized.en?.trim() ||
		Object.values(localized)
			.find((value) => value?.trim())
			?.trim() ||
		name.trim()
	return text.slice(0, 200)
}

/** Where a response opens, relative to the organization (Mailbox). */
export function formResponsePath(formId: string): string {
	return `/mailbox?${new URLSearchParams({ source: 'forms', form: formId })}`
}

/**
 * The full link for a response alert, from the shared registry
 * (`@repo/common/links`, type `operator_form_response`): the operator mobile
 * app opens it as an app link, the browser as the Mailbox.
 */
export function formResponseLink(
	baseUrl: string,
	orgSlug: string,
	formId: string,
): string | null {
	return buildOperatorLink(
		'operator_form_response',
		{ source: 'forms', form: formId },
		{ baseUrl, orgSlug },
	)
}
