import { type CartItem, type FulfillmentMode } from './types.ts'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type CartStore = {
	readonly key: string
	load(): CartItem[]
	save(items: CartItem[]): void
	add(item: Omit<CartItem, 'id'> & { id?: string }): CartItem
	setQuantity(lineId: string, quantity: number): void
	remove(lineId: string): void
	clear(): void
	lines(): CartItem[]
	count(): number
	subtotal(): number
	subscribe(listener: (lines: CartItem[]) => void): () => void
}

function memoryStorage(): StorageLike {
	const map = new Map<string, string>()
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
		removeItem: (k) => void map.delete(k),
	}
}

function resolveStorage(storage?: StorageLike): StorageLike {
	if (storage) return storage
	try {
		if (typeof localStorage !== 'undefined') return localStorage
	} catch {
		// Access can throw in sandboxed frames; fall back to memory.
	}
	return memoryStorage()
}

function isCartItem(value: unknown): value is CartItem {
	if (!value || typeof value !== 'object') return false
	const v = value as Record<string, unknown>
	return (
		typeof v.id === 'string' &&
		typeof v.itemId === 'string' &&
		typeof v.name === 'string' &&
		typeof v.instructions === 'string' &&
		typeof v.quantity === 'number' &&
		Number.isSafeInteger(v.quantity) &&
		v.quantity > 0 &&
		typeof v.unitPrice === 'number' &&
		Number.isFinite(v.unitPrice) &&
		v.unitPrice >= 0 &&
		typeof v.basePrice === 'number' &&
		Number.isFinite(v.basePrice) &&
		v.basePrice >= 0 &&
		Array.isArray(v.options) &&
		v.options.every((option: unknown) => {
			if (!option || typeof option !== 'object') return false
			const o = option as Record<string, unknown>
			return (
				typeof o.groupId === 'string' &&
				typeof o.groupName === 'string' &&
				typeof o.optionId === 'string' &&
				typeof o.optionName === 'string' &&
				typeof o.priceDelta === 'number' &&
				Number.isFinite(o.priceDelta) &&
				(o.quantity === undefined ||
					(typeof o.quantity === 'number' &&
						Number.isSafeInteger(o.quantity) &&
						o.quantity > 0)) &&
				(o.half === undefined ||
					['whole', 'left', 'right'].includes(String(o.half)))
			)
		})
	)
}

function lineSignature(item: Omit<CartItem, 'id' | 'quantity'>): string {
	const options = [...(item.options ?? [])]
		.map(
			(o) =>
				`${o.groupId}:${o.optionId}:${o.half ?? ''}:${o.quantity ?? 1}:${o.priceDelta}`,
		)
		.sort()
	return JSON.stringify([
		item.itemId,
		item.variantId ?? '',
		options,
		item.instructions ?? '',
	])
}

export function newLineId(): string {
	return `cart_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function createCartStore(options: {
	key: string
	storage?: StorageLike
}): CartStore {
	const storage = resolveStorage(options.storage)
	const listeners = new Set<(lines: CartItem[]) => void>()
	let items: CartItem[] = read()

	function read(): CartItem[] {
		try {
			const raw = storage.getItem(options.key)
			if (!raw) return []
			const parsed: unknown = JSON.parse(raw)
			return Array.isArray(parsed) ? parsed.filter(isCartItem) : []
		} catch {
			return []
		}
	}

	function write() {
		try {
			if (items.length) storage.setItem(options.key, JSON.stringify(items))
			else storage.removeItem(options.key)
		} catch {
			// Quota or privacy mode: keep the in-memory cart working.
		}
		notify()
	}

	function notify() {
		const snapshot = items.map((line) => ({ ...line }))
		for (const listener of listeners) listener(snapshot)
	}

	if (typeof window !== 'undefined') {
		window.addEventListener('storage', (event) => {
			if (event.key !== options.key) return
			items = read()
			notify()
		})
	}

	return {
		key: options.key,
		load() {
			items = read()
			return items.map((line) => ({ ...line }))
		},
		save(next) {
			items = next.filter(isCartItem)
			write()
		},
		add(item) {
			const candidate = { ...item, id: item.id ?? newLineId() }
			if (!isCartItem(candidate)) throw new Error('Invalid cart item')
			const signature = lineSignature(item)
			const existing = items.find(
				(line) => line.quantity > 0 && lineSignature(line) === signature,
			)
			if (existing) {
				existing.quantity += item.quantity
				write()
				return { ...existing }
			}
			const line: CartItem = candidate
			items.push(line)
			write()
			return { ...line }
		},
		setQuantity(lineId, quantity) {
			if (!Number.isFinite(quantity)) return
			const line = items.find((l) => l.id === lineId)
			if (!line) return
			if (quantity <= 0) items = items.filter((l) => l.id !== lineId)
			else line.quantity = Math.floor(quantity)
			write()
		},
		remove(lineId) {
			items = items.filter((l) => l.id !== lineId)
			write()
		},
		clear() {
			items = []
			write()
		},
		lines() {
			return items.map((line) => ({ ...line }))
		},
		count() {
			return items.reduce((acc, line) => acc + line.quantity, 0)
		},
		subtotal() {
			return items.reduce(
				(acc, line) => acc + line.unitPrice * line.quantity,
				0,
			)
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => void listeners.delete(listener)
		},
	}
}

export type ModeStore = {
	get(): FulfillmentMode
	set(mode: FulfillmentMode): void
	subscribe(listener: (mode: FulfillmentMode) => void): () => void
}

export function createModeStore(options: {
	key: string
	allowed?: FulfillmentMode[]
	storage?: StorageLike
}): ModeStore {
	const storage = resolveStorage(options.storage)
	const allowed = options.allowed?.length
		? options.allowed
		: (['pickup', 'delivery'] as FulfillmentMode[])
	const listeners = new Set<(mode: FulfillmentMode) => void>()

	const normalize = (value: string | null): FulfillmentMode => {
		const mode = value === 'delivery' ? 'delivery' : 'pickup'
		return allowed.includes(mode) ? mode : (allowed[0] ?? 'pickup')
	}

	let current = normalize(
		(() => {
			try {
				return storage.getItem(options.key)
			} catch {
				return null
			}
		})(),
	)

	return {
		get: () => current,
		set(mode) {
			current = normalize(mode)
			try {
				storage.setItem(options.key, current)
			} catch {
				// Ignore storage failures; the in-memory mode still applies.
			}
			for (const listener of listeners) listener(current)
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => void listeners.delete(listener)
		},
	}
}
