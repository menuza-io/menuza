const MAX_CAUSE_DEPTH = 5

/** Busy errors arrive bare from the driver or wrapped (drizzle sets `cause`). */
export function isSqliteBusyError(error: unknown): boolean {
	let current: unknown = error
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (!(current instanceof Error)) return false
		if (current.message.includes('SQLITE_BUSY')) return true
		const code = (current as { code?: unknown }).code
		if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) {
			return true
		}
		const cause: unknown = (current as { cause?: unknown }).cause
		if (cause === current) return false
		current = cause
	}
	return false
}

export async function retryOnSqliteBusy<T>(
	operation: () => Promise<T>,
): Promise<T> {
	let lastError: unknown
	for (const delayMs of [0, 10, 25, 50, 100, 200]) {
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		}
		try {
			return await operation()
		} catch (error) {
			if (!isSqliteBusyError(error)) throw error
			lastError = error
		}
	}
	throw lastError
}
