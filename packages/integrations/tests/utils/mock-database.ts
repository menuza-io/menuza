import { vi } from 'vitest'

type QueryResult = unknown[]

export function queryChain(rows: QueryResult = []): any {
	const chain: Record<string, any> = {
		from: () => chain,
		where: () => chain,
		limit: () => chain,
		orderBy: () => chain,
		innerJoin: () => chain,
		leftJoin: () => chain,
		values: () => chain,
		set: () => chain,
		onConflictDoNothing: () => chain,
		onConflictDoUpdate: () => chain,
		returning: () => chain,
		// oxlint-disable-next-line unicorn/no-thenable
		then: (
			resolve: (value: QueryResult) => unknown,
			reject?: (error: unknown) => unknown,
		) => Promise.resolve(rows).then(resolve, reject),
	}
	return chain
}

export const mockDb = {
	select: vi.fn(() => queryChain()),
	insert: vi.fn(() => queryChain()),
	update: vi.fn(() => queryChain()),
	delete: vi.fn(() => queryChain()),
	transaction: vi.fn(async (callback: (tx: typeof mockDb) => unknown) =>
		callback(mockDb),
	),
}

export function resetMockDb() {
	vi.clearAllMocks()
	mockDb.select.mockImplementation(() => queryChain())
	mockDb.insert.mockImplementation(() => queryChain())
	mockDb.update.mockImplementation(() => queryChain())
	mockDb.delete.mockImplementation(() => queryChain())
}
