import { type OrderMarketingConsentResult } from '@repo/common/marketing-consent'
import { getAccessToken, tenantFetchResponse } from '~/lib/client-auth'

/**
 * Browser half of the marketing opt-ins (checkout and sign-up boxes, the
 * profile switches). Every call goes straight to the regional tenant-api with
 * the customer token; Sites never sees who is subscribed. Boxes are never
 * pre-ticked and each channel is its own choice.
 */

export type ConsentChannel = 'email' | 'sms'
export type ConsentTopic =
	'marketing' | 'product_updates' | 'drops' | 'reservations'
export type ConsentSource = 'profile' | 'signup' | 'checkout'

export type SubscriptionRow = {
	topic: ConsentTopic
	channel: ConsentChannel
	subscribed: boolean
	confirmed?: boolean
}

/** `pending`: an email opt-in waiting for the emailed link. */
export type SubscriptionState = 'off' | 'on' | 'pending'

export type MarketingConsentPayload = {
	email?: true
	sms?: true
	textVersion: string
}

export type SetSubscriptionResult =
	| { status: 'ok'; state: SubscriptionState }
	| { status: 'needs_email' | 'needs_phone' | 'error' }

export function subscriptionState(
	rows: readonly SubscriptionRow[] | null | undefined,
	topic: ConsentTopic,
	channel: ConsentChannel,
): SubscriptionState {
	const row = rows?.find((r) => r.topic === topic && r.channel === channel)
	if (!row?.subscribed) return 'off'
	return channel === 'email' && row.confirmed === false ? 'pending' : 'on'
}

/** `null`: not signed in, or the region could not be asked for now. */
export async function fetchSubscriptions(): Promise<SubscriptionRow[] | null> {
	if (!getAccessToken()) return null
	try {
		const res = await tenantFetchResponse('/subscriptions')
		if (!res.ok) return null
		const data = (await res.json()) as { subscriptions?: SubscriptionRow[] }
		return Array.isArray(data.subscriptions) ? data.subscriptions : []
	} catch {
		return null
	}
}

export async function setSubscription(
	topic: ConsentTopic,
	channel: ConsentChannel,
	subscribed: boolean,
	source: ConsentSource,
	/** The id of the wording the guest was shown; omit when none covers this switch. */
	textVersion?: string,
): Promise<SetSubscriptionResult> {
	try {
		const res = await tenantFetchResponse(
			`/subscriptions/${topic}/${channel}`,
			{
				method: 'PUT',
				body: JSON.stringify({
					subscribed,
					source,
					...(subscribed && textVersion ? { textVersion } : {}),
				}),
			},
		)
		if (res.status === 409) {
			return { status: channel === 'email' ? 'needs_email' : 'needs_phone' }
		}
		if (!res.ok) return { status: 'error' }
		const data = (await res.json().catch(() => ({}))) as { pending?: boolean }
		return {
			status: 'ok',
			state: !subscribed ? 'off' : data.pending ? 'pending' : 'on',
		}
	} catch {
		return { status: 'error' }
	}
}

/**
 * What goes on an order: only the ticked channels, and nothing at all when
 * none is ticked or the guest is not signed in (the region honours it only
 * with a customer token).
 */
export function buildMarketingConsent(
	choice: { email?: boolean; sms?: boolean },
	signedIn: boolean,
	textVersion: string | undefined,
): MarketingConsentPayload | undefined {
	if (!signedIn || !textVersion || (!choice.email && !choice.sms))
		return undefined
	return {
		...(choice.email ? { email: true as const } : {}),
		...(choice.sms ? { sms: true as const } : {}),
		textVersion,
	}
}

/** The ticked boxes inside a `MarketingConsentBoxes` root. */
export function readConsentChoice(root: ParentNode | null): {
	email: boolean
	sms: boolean
} {
	const ticked = (channel: ConsentChannel) =>
		Boolean(
			root?.querySelector<HTMLInputElement>(
				`input[data-consent-channel="${channel}"]:checked:not(:disabled)`,
			),
		)
	return { email: ticked('email'), sms: ticked('sms') }
}

/** The wording id the boxes were rendered with (`data-text-version`). */
export function readConsentTextVersion(root: ParentNode | null) {
	return (
		root?.querySelector<HTMLElement>('[data-text-version]')?.dataset
			.textVersion ||
		(root as HTMLElement | null)?.dataset?.textVersion ||
		undefined
	)
}

export function checkoutMarketingConsent(
	root: ParentNode | null = document.querySelector('[data-marketing-consent]'),
): MarketingConsentPayload | undefined {
	return buildMarketingConsent(
		readConsentChoice(root),
		Boolean(getAccessToken()),
		readConsentTextVersion(root),
	)
}

/**
 * Sign-up: the boxes ticked after the first phone check. One failed call
 * (no email on file, an offline region) never fails the step it rides on.
 */
export async function recordSignupConsent(
	choice: { email?: boolean; sms?: boolean },
	textVersion: string | undefined,
): Promise<void> {
	const calls: Promise<unknown>[] = []
	if (choice.email)
		calls.push(
			setSubscription('marketing', 'email', true, 'signup', textVersion),
		)
	if (choice.sms)
		calls.push(setSubscription('marketing', 'sms', true, 'signup', textVersion))
	await Promise.allSettled(calls)
}

const EMAIL_PENDING_KEY = 'menuza_marketing_email_pending'

/**
 * Checkout hands this to the success page; no contact data is stored. The flag
 * names the order it belongs to, so a success page for another order (or one
 * that returned early and never read it) can never show it.
 */
export function flagEmailConfirmationPending(
	result: OrderMarketingConsentResult | undefined,
	orderId: string,
	storage: Pick<Storage, 'setItem'> = sessionStorage,
) {
	if (result?.email !== 'pending' || !orderId) return
	try {
		storage.setItem(EMAIL_PENDING_KEY, orderId)
	} catch {
		// Storage can be off; the note is a nicety.
	}
}

/** True once, for the flagged order only: the flag is cleared on any read. */
export function takeEmailConfirmationPending(
	orderId: string,
	storage: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage,
): boolean {
	try {
		const flagged = storage.getItem(EMAIL_PENDING_KEY)
		if (flagged === null) return false
		storage.removeItem(EMAIL_PENDING_KEY)
		return flagged === orderId
	} catch {
		return false
	}
}

/**
 * Hides the box of a channel the guest already receives offers on. Never
 * blocks checkout: the boxes show first and this only takes rows away.
 */
export async function hideSubscribedBoxes(root: HTMLElement) {
	const rows = await fetchSubscriptions()
	if (!rows) return
	let visible = 0
	for (const row of root.querySelectorAll<HTMLElement>('[data-consent-row]')) {
		const channel = row.dataset.consentRow as ConsentChannel
		if (subscriptionState(rows, 'marketing', channel) === 'on') {
			row.hidden = true
			const input = row.querySelector<HTMLInputElement>('input')
			if (input) {
				input.checked = false
				input.disabled = true
			}
		} else {
			visible += 1
		}
	}
	if (visible === 0) {
		root
			.querySelector<HTMLElement>('[data-consent-fieldset]')
			?.setAttribute('hidden', '')
	}
}

export function mountMarketingConsent(root: HTMLElement) {
	void hideSubscribedBoxes(root)
}
