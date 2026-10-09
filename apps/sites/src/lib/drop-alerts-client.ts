import {
	getAccessToken,
	getOrgBinding,
	setSessionTokens,
	tenantErrorMessage,
	tenantFetch,
	tenantJson,
} from '~/lib/client-auth'

/**
 * Browser half of `DropAlertsSignup`: phone → code → subscribe for signed-out
 * visitors, one tap for signed-in ones, a switch on the profile. Every call
 * goes straight to tenant-api (customer PII stays out of Sites).
 */

export type DropAlertsState = 'phone' | 'code' | 'signed-in' | 'done'

const SUBSCRIBED_EVENT = 'drop-alerts:subscribed'

/** `data-when="phone code"` → visible in those states. */
export function isVisibleInState(
	when: string | undefined,
	state: DropAlertsState,
) {
	return (when ?? '').split(/\s+/).includes(state)
}

export async function fetchDropAlertsSubscribed(): Promise<boolean | null> {
	try {
		const res = await tenantFetch('/subscriptions')
		if (!res.ok) return null
		const data = (await res.json()) as { drops?: { sms?: boolean } }
		return Boolean(data.drops?.sms)
	} catch {
		return null
	}
}

export async function setDropAlertsSubscribed(
	subscribed: boolean,
	source: string,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
	const res = await tenantFetch('/subscriptions/drops', {
		method: 'PUT',
		body: JSON.stringify({ subscribed, source }),
	})
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
	return { ok: res.ok, data }
}

export function mountDropAlerts(root: HTMLElement) {
	const source = root.dataset.source ?? 'menu'
	const labels = {
		sending: root.dataset.labelSending ?? '…',
		codeSent: root.dataset.labelCodeSent ?? '',
		network: root.dataset.labelNetwork ?? 'Network error.',
		error: root.dataset.labelError ?? 'Something went wrong.',
	}
	const errorEl = root.querySelector<HTMLElement>('[data-error]')

	const showError = (message: string | null) => {
		if (!errorEl) return
		errorEl.textContent = message ?? ''
		errorEl.hidden = !message
	}
	const ready = () => {
		root.dataset.ready = ''
	}
	const hide = () => {
		root.dataset.hidden = ''
		ready()
	}

	if (root.dataset.layout === 'toggle') {
		mountToggle(root, source, { ready, hide })
		return
	}

	const setState = (state: DropAlertsState) => {
		root.dataset.state = state
		for (const el of root.querySelectorAll<HTMLElement>('[data-when]')) {
			el.hidden = !isVisibleInState(el.dataset.when, state)
		}
		showError(null)
	}

	const busy = async <T>(
		button: HTMLButtonElement | null,
		run: () => Promise<T>,
	) => {
		const label = button?.dataset.label ?? button?.textContent ?? ''
		if (button) {
			button.disabled = true
			button.textContent = labels.sending
		}
		try {
			return await run()
		} finally {
			if (button) {
				button.disabled = false
				button.textContent = label
			}
		}
	}

	const subscribe = async () => {
		const { ok, data } = await setDropAlertsSubscribed(true, source)
		if (!ok) {
			showError(tenantErrorMessage(data, labels.error))
			return
		}
		setState('done')
		document.dispatchEvent(new CustomEvent(SUBSCRIBED_EVENT, { detail: root }))
	}

	// Another signup on the page went through: the rest step aside.
	document.addEventListener(SUBSCRIBED_EVENT, (event) => {
		if ((event as CustomEvent).detail !== root) hide()
	})

	const phoneForm = root.querySelector<HTMLFormElement>(
		'form[data-step="phone"]',
	)
	const codeForm = root.querySelector<HTMLFormElement>('form[data-step="code"]')
	const codeHint = root.querySelector<HTMLElement>('[data-code-hint]')
	const signedInButton = root.querySelector<HTMLButtonElement>(
		'[data-step="signed-in"]',
	)
	let phone = ''

	phoneForm?.addEventListener('submit', async (event) => {
		event.preventDefault()
		const input = phoneForm.elements.namedItem('phone') as HTMLInputElement
		phone = input.value.trim()
		if (phone.length < 5) {
			input.focus()
			return
		}
		await busy(phoneForm.querySelector('button[type="submit"]'), async () => {
			try {
				const { ok, data } = await tenantJson('/auth/send-code', {
					phone,
					...getOrgBinding(),
				})
				if (!ok) {
					showError(tenantErrorMessage(data, labels.error))
					return
				}
				setState('code')
				if (codeHint)
					codeHint.textContent = labels.codeSent.replace('{phone}', phone)
				codeForm?.querySelector<HTMLInputElement>('input[name="code"]')?.focus()
			} catch {
				showError(labels.network)
			}
		})
	})

	codeForm?.addEventListener('submit', async (event) => {
		event.preventDefault()
		const input = codeForm.elements.namedItem('code') as HTMLInputElement
		const code = input.value.replace(/\D/g, '')
		if (code.length !== 6) {
			input.focus()
			return
		}
		await busy(codeForm.querySelector('button[type="submit"]'), async () => {
			try {
				const { ok, data } = await tenantJson('/auth/verify', {
					phone,
					code,
					...getOrgBinding(),
				})
				if (!ok || typeof data.accessToken !== 'string') {
					showError(tenantErrorMessage(data, labels.error))
					return
				}
				setSessionTokens({
					accessToken: data.accessToken,
					refreshToken:
						typeof data.refreshToken === 'string'
							? data.refreshToken
							: undefined,
				})
				await subscribe()
			} catch {
				showError(labels.network)
			}
		})
	})

	root.querySelector('[data-change-number]')?.addEventListener('click', () => {
		setState('phone')
		phoneForm?.querySelector<HTMLInputElement>('input[name="phone"]')?.focus()
	})

	signedInButton?.addEventListener('click', () =>
		busy(signedInButton, async () => {
			try {
				await subscribe()
			} catch {
				showError(labels.network)
			}
		}),
	)

	if (!getAccessToken()) {
		setState('phone')
		ready()
		return
	}
	void fetchDropAlertsSubscribed().then((subscribed) => {
		if (subscribed) return hide()
		// `null`: the session didn't survive a refresh, so treat as signed out.
		setState(subscribed === false ? 'signed-in' : 'phone')
		ready()
	})
}

function mountToggle(
	root: HTMLElement,
	source: string,
	{ ready, hide }: { ready: () => void; hide: () => void },
) {
	const toggle = root.querySelector<HTMLButtonElement>('[data-toggle]')
	const status = root.querySelector<HTMLElement>('[data-toggle-status]')
	if (!toggle || !getAccessToken()) return hide()

	const paint = (on: boolean) => {
		toggle.setAttribute('aria-checked', String(on))
		if (status)
			status.textContent = (on ? status.dataset.on : status.dataset.off) ?? ''
	}

	toggle.addEventListener('click', async () => {
		const next = toggle.getAttribute('aria-checked') !== 'true'
		paint(next)
		toggle.disabled = true
		try {
			const { ok } = await setDropAlertsSubscribed(next, source)
			if (!ok) paint(!next)
		} catch {
			paint(!next)
		} finally {
			toggle.disabled = false
		}
	})

	void fetchDropAlertsSubscribed().then((subscribed) => {
		if (subscribed === null) return hide()
		paint(subscribed)
		toggle.disabled = false
		ready()
	})
}
