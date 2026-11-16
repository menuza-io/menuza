import { GIFT_CARD_SHOW_TOKEN_TTL_MS } from '@repo/common/gift-cards'
import { type CustomerSession } from '../session/customer-session'
import { type CustomerFeature } from '../state/app-store'
import {
	GiftCardsClient,
	GiftCardsClientError,
	giftCardsErrorCode,
	isSessionEndCode,
	type GiftCardsClientErrorCode,
	type GiftCardsClientPlatform,
	type SavedGiftCardDto,
} from './gift-cards-client'

/**
 * The gift card wallet as a store: saved cards, adding one by its code, and a
 * short-lived token the till scans. State is codes and numbers, never English;
 * screens render it with `./labels` and `../loyalty/format`.
 *
 * A saved card is a convenience, not a lock: anyone with the full code can
 * still spend it. Nothing here keeps a card code: the code typed to add a card
 * goes to the region and is dropped.
 */

export type GiftCardsError = {
	readonly code: GiftCardsClientErrorCode
	/** The region's rate-limit hint, when it gave one. */
	readonly retryAfterSeconds: number | null
}

export type GiftCardsClaimState = {
	readonly status: 'idle' | 'claiming'
	readonly error: GiftCardsError | null
	/** The last four of the card just saved, for the confirmation line. */
	readonly savedLast4: string | null
	readonly alreadyMine: boolean
}

export type GiftCardsTokenState = {
	readonly status: 'idle' | 'issuing'
	readonly cardId: string | null
	readonly token: string | null
	/** When the token stops working on this device's clock; `null` without a token. */
	readonly deadlineMs: number | null
	readonly expired: boolean
	readonly error: GiftCardsError | null
}

export type GiftCardsSnapshot = {
	/** Whether this site takes gift cards online; `unknown` until the first answer. */
	readonly availability: 'unknown' | 'available' | 'unavailable'
	readonly status: 'idle' | 'loading' | 'ready' | 'signedOut' | 'failed'
	readonly cards: readonly SavedGiftCardDto[]
	readonly error: GiftCardsError | null
	readonly claim: GiftCardsClaimState
	readonly token: GiftCardsTokenState
}

const IDLE_CLAIM: GiftCardsClaimState = {
	status: 'idle',
	error: null,
	savedLast4: null,
	alreadyMine: false,
}

const IDLE_TOKEN: GiftCardsTokenState = {
	status: 'idle',
	cardId: null,
	token: null,
	deadlineMs: null,
	expired: false,
	error: null,
}

const INITIAL: GiftCardsSnapshot = {
	availability: 'unknown',
	status: 'idle',
	cards: [],
	error: null,
	claim: IDLE_CLAIM,
	token: IDLE_TOKEN,
}

type TimerHandle = ReturnType<typeof setTimeout> | null

export type GiftCardsStoreOptions = {
	session: CustomerSession
	platform?: GiftCardsClientPlatform
	/** Test seam. */
	client?: Pick<GiftCardsClient, 'available' | 'mine' | 'claim' | 'showToken'>
	now?: () => number
	/** The session turned out to be dead (revoked, another organization): sign out app-wide. */
	onSessionEnded?: () => void
}

/**
 * What the till scans must never outlive the server's own deadline, and a
 * device clock that runs fast or slow must not stretch it: the deadline is
 * never later than one TTL after the token arrived, nor already past on arrival.
 */
export function giftCardTokenDeadline(
	expiresAt: number,
	receivedAt: number,
	ttlMs: number = GIFT_CARD_SHOW_TOKEN_TTL_MS,
): number {
	const remaining = expiresAt - receivedAt
	if (!Number.isFinite(remaining) || remaining <= 0 || remaining > ttlMs) {
		return receivedAt + ttlMs
	}
	return expiresAt
}

/** What a person types or pastes: spaces, dashes and case do not matter. */
export function normalizeGiftCardCode(input: string): string {
	return input.replace(/[\s-]+/g, '').toUpperCase()
}

export class GiftCardsStore implements CustomerFeature {
	readonly #client: Pick<
		GiftCardsClient,
		'available' | 'mine' | 'claim' | 'showToken'
	>
	readonly #now: () => number
	readonly #onSessionEnded: (() => void) | null
	readonly #listeners = new Set<() => void>()

	#snapshot: GiftCardsSnapshot = INITIAL
	#started = false
	#disposed = false
	#loadSeq = 0
	#tokenSeq = 0
	/** Changes only on `reset()` and `dispose()`: an answer from before it is dropped. */
	#epoch = 0
	#tokenTimer: TimerHandle = null

	constructor(options: GiftCardsStoreOptions) {
		this.#client =
			options.client ??
			new GiftCardsClient(options.session, {
				platform: options.platform ?? 'ios',
			})
		this.#now = options.now ?? (() => Date.now())
		this.#onSessionEnded = options.onSessionEnded ?? null
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	readonly getSnapshot = (): GiftCardsSnapshot => this.#snapshot

	// MARK: - Lifecycle

	/** Starts the first load; later calls share it. Call again after `reset()`. */
	start(): void {
		if (this.#started || this.#disposed) return
		this.#started = true
		void this.#load()
	}

	/** Reloads the cards; a refresh behind visible cards never blanks the screen. */
	refresh(): Promise<void> {
		return this.#load()
	}

	/** Clears everything and cancels in-flight work; a late answer is dropped. */
	reset(): void {
		this.#epoch += 1
		this.#loadSeq += 1
		this.#tokenSeq += 1
		this.#cancelTokenTimer()
		this.#started = false
		this.#update(INITIAL)
	}

	/** Stops for good. */
	dispose(): void {
		this.#disposed = true
		this.#epoch += 1
		this.#loadSeq += 1
		this.#tokenSeq += 1
		this.#cancelTokenTimer()
		this.#listeners.clear()
	}

	// MARK: - Loading

	async #load(): Promise<void> {
		if (this.#disposed) return
		const seq = (this.#loadSeq += 1)
		const hasCards = this.#snapshot.status === 'ready'
		if (!hasCards) this.#update({ status: 'loading', error: null })
		try {
			if (this.#snapshot.availability !== 'available') {
				const available = await this.#client.available()
				if (seq !== this.#loadSeq) return
				if (available !== true) {
					this.#update({
						availability: 'unavailable',
						status: 'ready',
						cards: [],
					})
					return
				}
				this.#update({ availability: 'available' })
			}
			const cards = await this.#client.mine()
			if (seq !== this.#loadSeq) return
			this.#update({ status: 'ready', cards, error: null })
		} catch (error) {
			if (seq !== this.#loadSeq) return
			const failure = this.#errorOf(error)
			if (isSessionEndCode(failure.code)) {
				this.#endSession()
				return
			}
			// A refresh that fails keeps the cards on screen and says why.
			this.#update({ status: hasCards ? 'ready' : 'failed', error: failure })
		}
	}

	// MARK: - Adding a card

	/** Saves a card to the account by its full code; resolves whether it worked. */
	async claim(input: string): Promise<boolean> {
		if (this.#disposed || this.#snapshot.claim.status === 'claiming')
			return false
		const code = normalizeGiftCardCode(input)
		if (!code) {
			this.#update({
				claim: {
					...IDLE_CLAIM,
					error: { code: 'invalid_request', retryAfterSeconds: null },
				},
			})
			return false
		}
		const epoch = this.#epoch
		this.#update({ claim: { ...IDLE_CLAIM, status: 'claiming' } })
		try {
			const result = await this.#client.claim(code)
			if (this.#disposed || epoch !== this.#epoch) return false
			this.#update({
				claim: {
					...IDLE_CLAIM,
					savedLast4: result.card.last4,
					alreadyMine: result.alreadyMine,
				},
			})
			void this.#load()
			return true
		} catch (error) {
			if (this.#disposed || epoch !== this.#epoch) return false
			const failure = this.#errorOf(error)
			if (isSessionEndCode(failure.code)) {
				this.#endSession()
				return false
			}
			this.#update({ claim: { ...IDLE_CLAIM, error: failure } })
			return false
		}
	}

	dismissClaim(): void {
		if (this.#snapshot.claim.status === 'claiming') return
		this.#update({ claim: IDLE_CLAIM })
	}

	// MARK: - Showing a card at the till

	/** Asks for a one-use token for a saved card; a new one replaces the last. */
	async showAtTill(cardId: string): Promise<void> {
		if (this.#disposed || this.#snapshot.token.status === 'issuing') return
		const seq = (this.#tokenSeq += 1)
		this.#cancelTokenTimer()
		this.#update({ token: { ...IDLE_TOKEN, status: 'issuing', cardId } })
		try {
			const result = await this.#client.showToken(cardId)
			if (seq !== this.#tokenSeq) return
			const receivedAt = this.#now()
			const deadlineMs = giftCardTokenDeadline(result.expiresAt, receivedAt)
			this.#update({
				token: { ...IDLE_TOKEN, cardId, token: result.token, deadlineMs },
			})
			this.#scheduleExpiry(deadlineMs - receivedAt, seq)
		} catch (error) {
			if (seq !== this.#tokenSeq) return
			const failure = this.#errorOf(error)
			if (isSessionEndCode(failure.code)) {
				this.#endSession()
				return
			}
			this.#update({ token: { ...IDLE_TOKEN, cardId, error: failure } })
		}
	}

	/** Hides the token (the person closed it); it stays valid until it expires. */
	hideToken(): void {
		this.#tokenSeq += 1
		this.#cancelTokenTimer()
		this.#update({ token: IDLE_TOKEN })
	}

	#scheduleExpiry(delayMs: number, seq: number): void {
		this.#cancelTokenTimer()
		this.#tokenTimer = setTimeout(
			() => {
				this.#tokenTimer = null
				if (seq !== this.#tokenSeq || this.#disposed) return
				// An expired token is shown as expired, never as a scannable code.
				this.#update({
					token: {
						...IDLE_TOKEN,
						cardId: this.#snapshot.token.cardId,
						expired: true,
					},
				})
			},
			Math.max(0, delayMs),
		)
	}

	#cancelTokenTimer(): void {
		if (this.#tokenTimer !== null) clearTimeout(this.#tokenTimer)
		this.#tokenTimer = null
	}

	// MARK: - Internals

	#errorOf(error: unknown): GiftCardsError {
		return {
			code: giftCardsErrorCode(error),
			retryAfterSeconds:
				error instanceof GiftCardsClientError ? error.retryAfterSeconds : null,
		}
	}

	#endSession(): void {
		this.#update({ ...INITIAL, status: 'signedOut' })
		this.#onSessionEnded?.()
	}

	#update(patch: Partial<GiftCardsSnapshot>): void {
		if (this.#disposed) return
		this.#snapshot = { ...this.#snapshot, ...patch }
		for (const listener of [...this.#listeners]) listener()
	}
}
