/**
 * Shared in-process bounded LRU cache and per-org hourly rate limiter for paid
 * vision model document reads (`invoice-read`, `price-list`, `setup-import`).
 * Per node / Durable Object; keys include `orgId` and content hash or object key.
 */

export const INVOICE_READ_CACHE_TTL_MS = 60 * 60 * 1000
export const INVOICE_READS_PER_HOUR = 10
export const VISION_BATCH_READS_PER_HOUR = 60
const MAX_VISION_CACHE_ENTRIES = 500
const MAX_VISION_ORG_BUCKETS = 500

const readCache = new Map<string, { at: number; read: unknown }>()
const readStarts = new Map<string, number[]>()

export function resetInvoiceReadLimits(): void {
	readCache.clear()
	readStarts.clear()
}

export function getCachedVisionRead<T>(
	key: string,
	now = Date.now(),
): T | undefined {
	const entry = readCache.get(key)
	if (!entry) return undefined
	if (now - entry.at >= INVOICE_READ_CACHE_TTL_MS) {
		readCache.delete(key)
		return undefined
	}
	// Refresh LRU order.
	readCache.delete(key)
	readCache.set(key, entry)
	return entry.read as T
}

export function setCachedVisionRead<T>(
	key: string,
	read: T,
	now = Date.now(),
): void {
	if (readCache.has(key)) {
		readCache.delete(key)
	} else if (readCache.size >= MAX_VISION_CACHE_ENTRIES) {
		for (const [k, v] of readCache) {
			if (now - v.at >= INVOICE_READ_CACHE_TTL_MS) readCache.delete(k)
		}
		while (readCache.size >= MAX_VISION_CACHE_ENTRIES) {
			const oldest = readCache.keys().next().value
			if (!oldest) break
			readCache.delete(oldest)
		}
	}
	readCache.set(key, { at: now, read })
}

export function takeVisionReadSlot(
	orgId: string,
	now = Date.now(),
	maxPerHour = INVOICE_READS_PER_HOUR,
): boolean {
	const bucketKey = `${orgId}:${maxPerHour}`
	const recent = (readStarts.get(bucketKey) ?? []).filter(
		(at) => now - at < INVOICE_READ_CACHE_TTL_MS,
	)
	if (recent.length >= maxPerHour) {
		readStarts.set(bucketKey, recent)
		return false
	}
	recent.push(now)
	readStarts.delete(bucketKey)
	if (readStarts.size >= MAX_VISION_ORG_BUCKETS) {
		for (const [k, stamps] of readStarts) {
			const live = stamps.filter((at) => now - at < INVOICE_READ_CACHE_TTL_MS)
			if (live.length === 0) readStarts.delete(k)
		}
		while (readStarts.size >= MAX_VISION_ORG_BUCKETS) {
			const oldest = readStarts.keys().next().value
			if (!oldest) break
			readStarts.delete(oldest)
		}
	}
	readStarts.set(bucketKey, recent)
	return true
}
