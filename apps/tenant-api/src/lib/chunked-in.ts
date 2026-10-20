import {
	type AnyColumn,
	type SQL,
	type SQLWrapper,
	sql,
	type Table,
} from 'drizzle-orm'

/**
 * Cloudflare Durable Object SQLite allows at most 100 bound parameters per
 * statement, so an `IN (...)` list built from user-sized data (every
 * shift of a week, every person of a page) must be split. 90 leaves room
 * for the other parameters of the same statement (status filters, `set`
 * values).
 */
export const MAX_IN_CHUNK = 90

/**
 * `column IN (<ids>)` as one bound parameter (a JSON array read with
 * `json_each`). Use it when the condition is a fragment inside a larger query
 * that cannot be split per chunk (aggregates, ordering, joins). Ids are strings.
 */
export function inJsonList(
	column: AnyColumn | SQL | SQLWrapper,
	ids: readonly string[],
): SQL {
	return sql`${column} in (select value from json_each(${JSON.stringify([...ids])}))`
}

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

/**
 * Multi-row `INSERT ... VALUES` binds rows x columns parameters, and Drizzle
 * binds a value for every column that has a default too, so the column count
 * is the table's, not the row's. Splits `rows` so each statement stays at or
 * under `MAX_IN_CHUNK` bound parameters.
 */
export async function insertRowsInChunks<T extends object, R>(
	table: Table,
	rows: readonly T[],
	run: (chunk: T[]) => PromiseLike<readonly R[]>,
	maxParams?: number,
): Promise<R[]>
export async function insertRowsInChunks<T extends object>(
	table: Table,
	rows: readonly T[],
	run: (chunk: T[]) => PromiseLike<unknown>,
	maxParams?: number,
): Promise<void>
export async function insertRowsInChunks<T extends object>(
	table: Table,
	rows: readonly T[],
	run: (chunk: T[]) => PromiseLike<unknown>,
	maxParams: number = MAX_IN_CHUNK,
): Promise<unknown[] | void> {
	const out: unknown[] = []
	if (rows.length === 0) return out
	const columns = Math.max(
		1,
		Object.keys(
			(table as unknown as Record<symbol, object>)[
				Symbol.for('drizzle:Columns')
			] ?? {},
		).length,
	)
	const perStatement = Math.max(1, Math.floor(maxParams / columns))
	await forEachInChunks(
		rows,
		async (chunk) => {
			const result = await run(chunk)
			if (Array.isArray(result)) out.push(...result)
		},
		perStatement,
	)
	return out
}
