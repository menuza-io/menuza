import {
	fetchSubscriptions,
	setSubscription,
	subscriptionState,
	type ConsentChannel,
	type ConsentTopic,
	type SubscriptionState,
} from '~/lib/marketing-consent-client'

/** Offers wording id rendered by the section; other topics sent none. */
const textVersionFor = (root: HTMLElement, topic: ConsentTopic) =>
	topic === 'marketing'
		? root.dataset.textVersionMarketing || undefined
		: undefined

/**
 * Browser half of `MessagesSection` (the profile's "Messages from ..."): loads
 * the subscriptions, paints the switches, and saves each flip optimistically.
 */
export async function mountMessagesSection(root: HTMLElement) {
	const text = {
		pending: root.dataset.labelPending ?? '',
		needsEmail: root.dataset.labelNeedsEmail ?? '',
		needsPhone: root.dataset.labelNeedsPhone ?? '',
		error: root.dataset.labelError ?? '',
	}
	const switches = [
		...root.querySelectorAll<HTMLButtonElement>('button[role="switch"]'),
	]
	const statusOf = (button: HTMLButtonElement) =>
		button.closest('li')?.querySelector<HTMLElement>('[data-status]')

	const paint = (button: HTMLButtonElement, state: SubscriptionState) => {
		button.setAttribute('aria-checked', String(state !== 'off'))
		button.dataset.state = state
	}
	// A topic row shows one line: the pending hint for its email switch, else
	// the last error.
	const say = (button: HTMLButtonElement, message: string) => {
		const el = statusOf(button)
		if (el) el.textContent = message
	}
	const refreshPending = (button: HTMLButtonElement) => {
		const pending = button
			.closest('li')
			?.querySelector('button[data-channel="email"][data-state="pending"]')
		say(button, pending ? text.pending : '')
	}

	const rows = await fetchSubscriptions()
	// Signed out, or the region cannot be asked: leave the section hidden.
	if (!rows) return
	for (const button of switches) {
		const topic = button.dataset.topic as ConsentTopic
		const channel = button.dataset.channel as ConsentChannel
		const state = subscriptionState(rows, topic, channel)
		paint(button, state)
		button.disabled = false
		// KSA: the offers Text switch is hidden unless there is a subscription
		// to turn off.
		if (state !== 'off') {
			const wrap = button.closest<HTMLElement>('[data-switch-row]')
			if (wrap) wrap.hidden = false
		}
	}
	for (const button of switches) refreshPending(button)
	root.hidden = false

	for (const button of switches) {
		button.addEventListener('click', async () => {
			// In flight: aria-disabled keeps keyboard focus on the switch (native
			// `disabled` would drop it), so activations are ignored by hand.
			if (button.getAttribute('aria-disabled') === 'true') return
			const topic = button.dataset.topic as ConsentTopic
			const channel = button.dataset.channel as ConsentChannel
			const before = (button.dataset.state as SubscriptionState) ?? 'off'
			const next = before === 'off'
			// KSA sends no marketing texts: never opt in, only out.
			if (
				next &&
				root.dataset.ksa === 'true' &&
				topic === 'marketing' &&
				channel === 'sms'
			)
				return
			paint(button, next ? 'on' : 'off')
			button.setAttribute('aria-disabled', 'true')
			button.setAttribute('aria-busy', 'true')
			const result = await setSubscription(
				topic,
				channel,
				next,
				'profile',
				textVersionFor(root, topic),
			)
			button.removeAttribute('aria-disabled')
			button.removeAttribute('aria-busy')
			if (result.status === 'ok') {
				paint(button, result.state)
				refreshPending(button)
				return
			}
			paint(button, before)
			say(
				button,
				result.status === 'needs_email'
					? text.needsEmail
					: result.status === 'needs_phone'
						? text.needsPhone
						: text.error,
			)
		})
	}
}
