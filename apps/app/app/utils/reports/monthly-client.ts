import {
	FIGURES,
	figureValue,
	MONTHLY_PRESET,
	monthlyAsOf,
	type FigureId,
	type FigureValue,
	type ReportResult,
} from '@repo/reports'

/**
 * Browser-direct figures for the monthly results page and the billing line
 * (#221): the same report definitions the email and the Reports pages use, run
 * by the region's `POST /analytics/query` with the member's own reports token,
 * so a line the token does not cover is simply not returned (hidden, not zero).
 * Nothing passes through the US App.
 */
export async function fetchMonthlyFigures(input: {
	tokenUrl: string
	tenantApiUrl: string
	month: string
	ids: readonly FigureId[]
	timeZone: string
	signal?: AbortSignal
	fetchImpl?: typeof fetch
}): Promise<FigureValue[]> {
	const doFetch = input.fetchImpl ?? fetch
	const tokenResponse = await doFetch(input.tokenUrl, { signal: input.signal })
	const tokenBody = (await tokenResponse.json().catch(() => ({}))) as {
		token?: unknown
	}
	if (!tokenResponse.ok || typeof tokenBody.token !== 'string') {
		throw new Error('monthly_token_failed')
	}
	const asOf = monthlyAsOf(input.month)
	const run = async (id: FigureId, at: Date): Promise<ReportResult | null> => {
		const response = await doFetch(
			`${input.tenantApiUrl.replace(/\/+$/, '')}/analytics/query`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${tokenBody.token as string}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					definition: FIGURES[id].definition(MONTHLY_PRESET),
					timeZone: input.timeZone,
					asOf: at.toISOString(),
				}),
				signal: input.signal,
			},
		)
		// 403: this member's token does not cover the line; leave it out.
		if (response.status === 403) return null
		if (!response.ok) throw new Error(`monthly_query_failed_${response.status}`)
		return (await response.json()) as ReportResult
	}
	const out: FigureValue[] = []
	await Promise.all(
		input.ids.map(async (id) => {
			const [current, previous] = await Promise.all([
				run(id, asOf.current),
				run(id, asOf.previous),
			])
			if (current) out.push(figureValue(id, current, previous))
		}),
	)
	return out
}
