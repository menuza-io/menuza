import { type SavedGiftCardDto } from '@repo/common/gift-card-contract'
import { getAccessToken } from '~/lib/client-auth'
import { claim, GiftCardClientError, listMine, showToken } from '~/lib/gift-cards/client'
import { fillGiftCardTemplate, readGiftCardLabels } from '~/lib/gift-cards/read-labels'
import { renderQrSvg } from '~/lib/careers/qr'
import { browserLocale, browserLocaleHref } from '~/lib/locale'

/**
 * The guest's saved gift cards: balance, last four characters and recent
 * activity, add by code (a card sent to their email arrives as a link that
 * carries the code in the URL fragment, never sent to a server until the
 * guest adds it), and a short-lived code to show at the till. Saving a card is
 * a convenience, not a lock: the full number still spends it.
 */

const root = document.getElementById('gift-card-wallet-root')
const labels = readGiftCardLabels()

const money = (minor: number, currency: string) =>
	new Intl.NumberFormat(browserLocale(), { style: 'currency', currency }).format(minor / 100)

function p(text: string, className = ''): HTMLParagraphElement {
	const node = document.createElement('p')
	node.className = className
	node.textContent = text
	return node
}

const KIND_LABEL: Record<string, string> = {
	issue: labels.activityBought,
	redeem: labels.activitySpent,
	refund: labels.activityReturned,
	top_up: labels.activityToppedUp,
	adjust: labels.activityAdjusted,
}

async function render(host: HTMLElement) {
	host.replaceChildren()
	if (!getAccessToken()) {
		const link = document.createElement('a')
		link.href = browserLocaleHref('/login')
		link.className = 'underline'
		link.textContent = labels.signIn
		const wrap = document.createElement('div')
		wrap.className = 'flex flex-col gap-2'
		wrap.append(p(labels.signInToSave), link)
		host.append(wrap)
		return
	}
	const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
	const pending = fragment.get('add')
	if (pending) {
		// Take the code out of the address bar before anything else runs.
		history.replaceState(null, '', window.location.pathname + window.location.search)
		try {
			await claim(pending)
			host.append(p(labels.added, 'text-sm'))
		} catch {
			host.append(p(labels.errorGeneric, 'text-sm text-destructive'))
		}
	}
	const cards = await listMine().catch(() => null)
	if (cards === 'signed_out' || cards === null) {
		host.append(p(labels.errorGeneric, 'text-sm text-destructive'))
		return
	}
	if (cards.length === 0) host.append(p(labels.walletEmpty, 'text-muted-foreground'))
	for (const card of cards) host.append(cardView(host, card))

	const form = document.createElement('form')
	form.className = 'flex flex-col gap-2'
	const input = document.createElement('input')
	input.className = 'h-11 rounded-md border border-input bg-background px-3 text-base'
	input.placeholder = labels.cardNumber ?? ''
	input.setAttribute('aria-label', labels.addCard ?? '')
	input.autocomplete = 'off'
	const submit = document.createElement('button')
	submit.type = 'submit'
	submit.className = 'h-11 rounded-md border border-input px-4'
	submit.textContent = labels.add
	const error = p('', 'text-sm text-destructive')
	form.append(p(labels.addCard, 'font-medium'), input, submit, error)
	form.addEventListener('submit', async (event) => {
		event.preventDefault()
		error.textContent = ''
		submit.disabled = true
		try {
			await claim(input.value.trim())
			await render(host)
		} catch (caught) {
			error.textContent =
				caught instanceof GiftCardClientError && caught.code === 'code_invalid'
					? labels.errorNotFound
					: labels.errorGeneric
			submit.disabled = false
		}
	})
	host.append(form)
}

function cardView(host: HTMLElement, card: SavedGiftCardDto): HTMLElement {
	const box = document.createElement('div')
	box.className = 'flex flex-col gap-2 rounded-lg border border-border p-4'
	box.append(
		p(fillGiftCardTemplate(labels.endingIn, { last4: card.last4 }), 'text-sm text-muted-foreground'),
		p(money(card.balanceMinor, card.currency), 'text-2xl font-semibold'),
	)
	if (card.note === 'being_prepared') box.append(p(labels.statusPreparing, 'text-sm'))
	if (card.recent.length > 0) {
		box.append(p(labels.recentActivity, 'text-sm font-medium'))
		for (const entry of card.recent) {
			box.append(
				p(
					`${KIND_LABEL[entry.kind] ?? entry.kind}  ${money(entry.amountMinor, card.currency)}  ·  ${new Intl.DateTimeFormat(browserLocale(), { dateStyle: 'medium' }).format(entry.at)}`,
					'text-sm',
				),
			)
		}
	}
	if (card.status === 'active') {
		const show = document.createElement('button')
		show.type = 'button'
		show.className = 'h-10 self-start rounded-md border border-input px-4 text-sm'
		show.textContent = labels.showAtTill
		const out = document.createElement('div')
		show.addEventListener('click', async () => {
			show.disabled = true
			try {
				const token = await showToken(card.id)
				// The QR carries the one-use token, never the card number.
				const svg = await renderQrSvg(token.token)
				const qr = document.createElement('div')
				qr.className = 'size-48 self-start rounded bg-white p-1'
				qr.setAttribute('role', 'img')
				qr.setAttribute('aria-label', labels.showAtTill ?? '')
				if (svg) {
					const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
					qr.append(document.importNode(doc.documentElement, true))
				}
				out.replaceChildren(qr, p(labels.showHint, 'text-xs text-muted-foreground'))
				setTimeout(() => out.replaceChildren(), Math.max(0, token.expiresAt - Date.now()))
			} catch {
				out.replaceChildren(p(labels.errorGeneric, 'text-sm text-destructive'))
			} finally {
				show.disabled = false
			}
		})
		box.append(show, out)
	}
	void host
	return box
}

if (root) void render(root)
