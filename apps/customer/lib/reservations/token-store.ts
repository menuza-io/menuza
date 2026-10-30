import * as SecureStore from 'expo-secure-store'
import { z } from 'zod'

/**
 * The capability tokens a guest holds for their reservations and waitlist
 * entries: the manage token of each booking (`X-Reservation-Token`) and the
 * status token of each waitlist entry. They authorize reading and changing one
 * booking each, so they live in secure storage with the customer session,
 * never in plain storage, a URL or a log.
 */
export type StoredReservationTokens = {
	/** reservation id -> manage token, oldest first */
	readonly manage: Readonly<Record<string, string>>
	/** waitlist entry id -> status token */
	readonly waitlist: Readonly<Record<string, string>>
	/**
	 * The booking whose payment was started on this device and is not settled
	 * yet: its status poll resumes after the app was killed. Never the payment
	 * page URL, which carries a payment token.
	 */
	readonly payment?: string
}

/**
 * SecureStore warns above 2048 bytes per value (and older Android Keystore
 * versions refuse it), so the oldest manage tokens give way below that.
 */
export const RESERVATION_TOKENS_MAX_BYTES = 1800

export const EMPTY_RESERVATION_TOKENS: StoredReservationTokens = Object.freeze({
	manage: Object.freeze({}),
	waitlist: Object.freeze({}),
})

export function isEmptyReservationTokens(
	tokens: StoredReservationTokens,
): boolean {
	return (
		Object.keys(tokens.manage).length === 0 &&
		Object.keys(tokens.waitlist).length === 0 &&
		tokens.payment === undefined
	)
}

const storedTokensSchema = z.object({
	manage: z.record(z.string()).catch({}),
	waitlist: z.record(z.string()).catch({}),
	payment: z.string().optional().catch(undefined),
})

/** Unreadable or malformed storage reads as no tokens. */
export function parseReservationTokens(
	raw: string | null,
): StoredReservationTokens {
	if (!raw) return EMPTY_RESERVATION_TOKENS
	try {
		const parsed = storedTokensSchema.safeParse(JSON.parse(raw))
		return parsed.success ? parsed.data : EMPTY_RESERVATION_TOKENS
	} catch {
		return EMPTY_RESERVATION_TOKENS
	}
}

export function serializeReservationTokens(
	tokens: StoredReservationTokens,
): string {
	return JSON.stringify({
		manage: tokens.manage,
		waitlist: tokens.waitlist,
		...(tokens.payment === undefined ? {} : { payment: tokens.payment }),
	})
}

/**
 * Drops the oldest manage tokens until the value fits. Waitlist tokens and
 * the token of a payment in progress are kept; a dropped manage token comes
 * back from `/mine` when its booking is opened.
 */
export function fitReservationTokens(
	tokens: StoredReservationTokens,
	maxBytes: number = RESERVATION_TOKENS_MAX_BYTES,
): StoredReservationTokens {
	let fitted = tokens
	const removable = Object.keys(tokens.manage).filter(
		(id) => id !== tokens.payment,
	)
	while (
		removable.length > 0 &&
		utf8Length(serializeReservationTokens(fitted)) > maxBytes
	) {
		const oldest = removable.shift()!
		fitted = { ...fitted, manage: withEntry(fitted.manage, oldest, null) }
	}
	return fitted
}

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).length
}

/** Where the serialized tokens live; `null` deletes them. */
export type ReservationTokenBackend = {
	read(): Promise<string | null>
	/** `false` when the value could not be persisted. */
	write(value: string | null): Promise<boolean>
}

function withEntry(
	map: Readonly<Record<string, string>>,
	id: string,
	token: string | null,
): Record<string, string> {
	const next = Object.fromEntries(
		Object.entries(map).filter(([key]) => key !== id),
	)
	if (token !== null) next[id] = token
	return next
}

/**
 * Reads and writes go through one queue, so two quick changes (remember a
 * booking, forget another) never overwrite each other.
 */
export class ReservationTokenStore {
	readonly #backend: ReservationTokenBackend
	#queue: Promise<unknown> = Promise.resolve()

	constructor(backend: ReservationTokenBackend) {
		this.#backend = backend
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(operation, operation)
		this.#queue = result.catch(() => undefined)
		return result
	}

	async #read(): Promise<StoredReservationTokens> {
		try {
			return parseReservationTokens(await this.#backend.read())
		} catch {
			return EMPTY_RESERVATION_TOKENS
		}
	}

	async #write(tokens: StoredReservationTokens): Promise<boolean> {
		try {
			return await this.#backend.write(
				isEmptyReservationTokens(tokens)
					? null
					: serializeReservationTokens(fitReservationTokens(tokens)),
			)
		} catch {
			return false
		}
	}

	#update(
		change: (tokens: StoredReservationTokens) => StoredReservationTokens,
	): Promise<boolean> {
		return this.#enqueue(async () => this.#write(change(await this.#read())))
	}

	load(): Promise<StoredReservationTokens> {
		return this.#enqueue(() => this.#read())
	}

	/** Returns `false` when the tokens could not be persisted; callers keep their in-memory copy for this run. */
	save(tokens: StoredReservationTokens): Promise<boolean> {
		return this.#enqueue(() => this.#write(tokens))
	}

	rememberManage(reservationId: string, token: string): Promise<boolean> {
		return this.#update((tokens) => ({
			...tokens,
			manage: withEntry(tokens.manage, reservationId, token),
		}))
	}

	rememberWaitlist(entryId: string, token: string): Promise<boolean> {
		return this.#update((tokens) => ({
			...tokens,
			waitlist: withEntry(tokens.waitlist, entryId, token),
		}))
	}

	forgetManage(reservationId: string): Promise<boolean> {
		return this.#update((tokens) => ({
			...tokens,
			manage: withEntry(tokens.manage, reservationId, null),
		}))
	}

	/** Forgets the manage tokens of bookings that are over (past, cancelled). */
	forgetManageMany(reservationIds: ReadonlySet<string>): Promise<boolean> {
		return this.#update((tokens) => ({
			...tokens,
			manage: Object.fromEntries(
				Object.entries(tokens.manage).filter(
					([id]) => !reservationIds.has(id) || id === tokens.payment,
				),
			),
		}))
	}

	rememberPayment(reservationId: string): Promise<boolean> {
		return this.#update((tokens) => ({ ...tokens, payment: reservationId }))
	}

	forgetPayment(reservationId: string): Promise<boolean> {
		return this.#update((tokens) => {
			if (tokens.payment !== reservationId) return tokens
			const { payment: ignoredPayment, ...rest } = tokens
			return rest
		})
	}

	forgetWaitlist(entryId: string): Promise<boolean> {
		return this.#update((tokens) => ({
			...tokens,
			waitlist: withEntry(tokens.waitlist, entryId, null),
		}))
	}

	clear(): Promise<boolean> {
		return this.save(EMPTY_RESERVATION_TOKENS)
	}
}

/**
 * The prefix of each organization's key (and the key builds before per-org
 * keys used). SecureStore keys may only hold letters, digits, `.`, `-` and `_`.
 */
export const RESERVATION_TOKENS_KEY = 'reservation-tokens'
/** The per-organization keys written so far, so a reinstall can delete them all. */
export const RESERVATION_TOKENS_INDEX_KEY = 'reservation-tokens.index'

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
	keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
}

/**
 * One key per organization: booking codes of one site never show up after
 * the app is connected to another.
 */
export function reservationTokensKey(orgId: string): string {
	return `${RESERVATION_TOKENS_KEY}.${orgId.replace(/[^\w.-]/g, '_')}`
}

const indexSchema = z.array(z.string())

async function readIndex(): Promise<string[]> {
	try {
		const raw = await SecureStore.getItemAsync(RESERVATION_TOKENS_INDEX_KEY)
		const parsed = indexSchema.safeParse(raw ? JSON.parse(raw) : [])
		return parsed.success ? parsed.data : []
	} catch {
		return []
	}
}

async function updateIndex(key: string, present: boolean): Promise<void> {
	const index = await readIndex()
	if (index.includes(key) === present) return
	const next = present
		? [...index, key]
		: index.filter((entry) => entry !== key)
	if (next.length === 0) {
		await SecureStore.deleteItemAsync(RESERVATION_TOKENS_INDEX_KEY)
		return
	}
	await SecureStore.setItemAsync(
		RESERVATION_TOKENS_INDEX_KEY,
		JSON.stringify(next),
		SECURE_OPTIONS,
	)
}

/** Every key that may hold booking codes, the index and the legacy key included. */
export async function storedReservationTokenKeys(): Promise<string[]> {
	return [
		...(await readIndex()),
		RESERVATION_TOKENS_INDEX_KEY,
		RESERVATION_TOKENS_KEY,
	]
}

/** Deletes the booking codes of every organization (the app left its site). */
export async function forgetAllReservationTokens(): Promise<void> {
	const keys = await storedReservationTokenKeys()
	await Promise.all(
		keys.map((key) => SecureStore.deleteItemAsync(key).catch(() => undefined)),
	)
}

/** Keychain or Android Keystore storage, with the same accessibility as the customer session. */
export function createSecureReservationTokenStore(
	orgId: string,
): ReservationTokenStore {
	const key = reservationTokensKey(orgId)
	return new ReservationTokenStore({
		async read() {
			return SecureStore.getItemAsync(key)
		},
		async write(value) {
			if (value === null) {
				await SecureStore.deleteItemAsync(key)
				await updateIndex(key, false)
				return true
			}
			await updateIndex(key, true)
			await SecureStore.setItemAsync(key, value, SECURE_OPTIONS)
			return true
		},
	})
}

/** Test storage; `raw` shows what would be persisted. */
export function createMemoryReservationTokenStore(
	initial: StoredReservationTokens = EMPTY_RESERVATION_TOKENS,
): ReservationTokenStore & { readonly raw: string | null } {
	let raw: string | null = isEmptyReservationTokens(initial)
		? null
		: serializeReservationTokens(initial)
	const store = new ReservationTokenStore({
		async read() {
			return raw
		},
		async write(value) {
			raw = value
			return true
		},
	})
	return Object.defineProperty(store, 'raw', {
		get: () => raw,
	}) as ReservationTokenStore & { readonly raw: string | null }
}
