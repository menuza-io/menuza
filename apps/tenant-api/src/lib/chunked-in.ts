/**
 * Cloudflare Durable Object SQLite allows at most 100 bound parameters per
 * statement, so an `IN (...)` list built from user-sized data (every
 * reservation of a day, every guest of a page) must be split. 90 leaves room
 * for the other parameters of the same statement (status filters, `set`
 * values).
 */
export const MAX_IN_CHUNK = 90

export function chunkIds<T>(
	ids: readonly T[],
	size: number = MAX_IN_CHUNK,
): T[][] {
	const chunks: T[][] = []
	for (let i = 0; i < ids.length; i += size) {
		chunks.push(ids.slice(i, i + size))
	}
	return chunks
}

/** Runs a select once per chunk of `ids` and concatenates the rows. */
export async function queryInChunks<T, R>(
	ids: readonly T[],
	run: (chunk: T[]) => PromiseLike<R[]>,
	size: number = MAX_IN_CHUNK,
): Promise<R[]> {
	const rows: R[] = []
	for (const chunk of chunkIds(ids, size)) {
		rows.push(...(await run(chunk)))
	}
	return rows
}

/** Runs a write once per chunk of `ids`. */
export async function forEachInChunks<T>(
	ids: readonly T[],
	run: (chunk: T[]) => PromiseLike<unknown>,
	size: number = MAX_IN_CHUNK,
): Promise<void> {
	for (const chunk of chunkIds(ids, size)) {
		await run(chunk)
	}
}
