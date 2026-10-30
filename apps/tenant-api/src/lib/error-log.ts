/**
 * What may be logged about an unexpected error. A driver error's message and
 * properties carry the failing statement and its bound values (names, phone
 * numbers, operator notes), so only names, codes and the stack frames
 * (without the message line) are kept.
 */
export function errorLogFields(error: unknown): {
	errorName: string
	errorCode?: string
	causeName?: string
	stack?: string
} {
	if (!(error instanceof Error)) return { errorName: typeof error }
	const cause = (error as { cause?: unknown }).cause
	const code =
		(error as { code?: unknown }).code ??
		(cause instanceof Error ? (cause as { code?: unknown }).code : undefined)
	const frames = error.stack
		?.split('\n')
		.filter((line) => /^\s+at /.test(line))
		.join('\n')
	return {
		errorName: error.name,
		...(typeof code === 'string' ? { errorCode: code } : {}),
		...(cause instanceof Error ? { causeName: cause.name } : {}),
		...(frames ? { stack: frames } : {}),
	}
}
