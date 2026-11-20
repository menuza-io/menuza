import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	type AccountCheckKind,
	type AccountCheckStepKey,
} from '@repo/common/customer-app'

/**
 * What the people who run the restaurant's app are told (#156). The in-app
 * notification carries the kind and the organization slug; the words are
 * written here. The email is in `expiry-alerts.server.ts`.
 */

export const CUSTOMER_APP_ALERT_KINDS = [
	'expiring_30',
	'expiring_7',
	'expired',
] as const
export type CustomerAppAlertKind = (typeof CUSTOMER_APP_ALERT_KINDS)[number]

export const CUSTOMER_APP_ALERT_TYPES: Record<CustomerAppAlertKind, string> = {
	expiring_30: 'customer-app-expiring-30',
	expiring_7: 'customer-app-expiring-7',
	expired: 'customer-app-expired',
}

const KINDS = new Map(
	(
		Object.entries(CUSTOMER_APP_ALERT_TYPES) as Array<
			[CustomerAppAlertKind, string]
		>
	).map(([kind, type]) => [type, kind]),
)

export function customerAppAlertKindFromNotificationType(
	type: unknown,
): CustomerAppAlertKind | null {
	return typeof type === 'string' ? (KINDS.get(type) ?? null) : null
}

export const customerAppAlertPath = () => '/settings/customer-app'

export function customerAppAlertCopy(
	kind: CustomerAppAlertKind,
	_: (descriptor: MessageDescriptor) => string,
): { subject: string; body: string } {
	switch (kind) {
		case 'expiring_30':
			return {
				subject: _(
					msg`**Your app’s developer account** expires within 30 days`,
				),
				body: _(
					msg`Renew it so the app stays in the store. Open the app page for the steps.`,
				),
			}
		case 'expiring_7':
			return {
				subject: _(msg`**Your app’s developer account** expires within 7 days`),
				body: _(msg`Renew it now or the app can be removed from the store.`),
			}
		case 'expired':
			return {
				subject: _(msg`**Your app’s developer account** has expired`),
				body: _(
					msg`The app can be removed from the store until you renew. Open the app page for the steps.`,
				),
			}
	}
}

/** The email for each alert, in plain English (a job has no request language). */
export function customerAppAlertEmail(kind: CustomerAppAlertKind): {
	subject: string
	headline: string
	detail: string
} {
	const copy: Record<
		CustomerAppAlertKind,
		{ headline: string; detail: string }
	> = {
		expiring_30: {
			headline: 'Your app’s developer account expires within 30 days',
			detail:
				'Renew it so your app stays in the store. The app page lists the steps.',
		},
		expiring_7: {
			headline: 'Your app’s developer account expires within 7 days',
			detail: 'Renew it now or your app can be removed from the store.',
		},
		expired: {
			headline: 'Your app’s developer account has expired',
			detail:
				'Your app can be removed from the store until you renew. The app page lists the steps.',
		},
	}
	return { subject: copy[kind].headline, ...copy[kind] }
}

/** Translated, step-by-step fixes for each failing check. */
export function accountStepText(
	step: AccountCheckStepKey,
	_: (descriptor: MessageDescriptor) => string,
): string {
	switch (step) {
		case 'renew_developer_account':
			return _(
				msg`Sign in to the developer account that publishes the app and renew the membership.`,
			)
		case 'pay_developer_fee':
			return _(
				msg`Pay the annual developer fee with a card that has not expired.`,
			)
		case 'accept_store_terms':
			return _(
				msg`Sign in to the store’s developer site and accept the new terms and agreements.`,
			)
		case 'accept_payment_terms':
			return _(
				msg`Accept the paid applications and payment terms in the store’s agreements section.`,
			)
		case 'restore_store_access':
			return _(
				msg`Invite our access user back to the developer account with the app manager role.`,
			)
	}
}

export function accountCheckTitle(
	kind: AccountCheckKind,
	_: (descriptor: MessageDescriptor) => string,
): string {
	switch (kind) {
		case 'developer_account':
			return _(msg`Developer account`)
		case 'store_terms':
			return _(msg`Store terms`)
		case 'payment_terms':
			return _(msg`Payment terms`)
		case 'store_access':
			return _(msg`Our access to the store account`)
	}
}
