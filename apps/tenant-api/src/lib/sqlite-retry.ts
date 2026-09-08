function isSqliteBusyError(error: unknown) {
	return error instanceof Error && error.message.includes('SQLITE_BUSY')
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
