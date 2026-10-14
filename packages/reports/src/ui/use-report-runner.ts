import { useEffect, useState } from 'react'
import { type ReportCatalog, getSubject } from '../catalog.ts'
import {
	type ReportDefinition,
	type ReportResult,
	type ReportRunError,
} from '../dsl.ts'
import { isReportRunError, validateReportDefinition } from '../engine.ts'

/** The viewer's own IANA zone, which a report set to "user timezone" follows. */
function viewerTimeZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone
	} catch {
		return undefined
	}
}

async function readJson(response: Response) {
	return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

/**
 * A 401 or 403 as the `unauthorized` run error, so callers can tell a
 * refusal from other failures even when its body is plain text.
 */
function refusalError(
	response: Response,
	message: string,
): ReportRunError | null {
	return response.status === 401 || response.status === 403
		? { error: 'unauthorized', message }
		: null
}

export function useReportRunner(options: {
	catalog: ReportCatalog
	definition: ReportDefinition
	controlPlaneRunUrl: string
	tenantTokenUrl?: string | null
	tenantApiUrl?: string | null
}) {
	const [result, setResult] = useState<ReportResult | null>(null)
	const [error, setError] = useState<ReportRunError | string | null>(null)
	const [loading, setLoading] = useState(false)
	const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

	useEffect(() => {
		const subject = getSubject(options.catalog, options.definition.subject)
		const validation = validateReportDefinition(
			options.catalog,
			options.definition,
		)
		if (validation) {
			setResult(null)
			setError(validation)
			setLoading(false)
			return
		}

		const controller = new AbortController()
		setLoading(true)
		setError(null)
		const timer = window.setTimeout(() => {
			void (async () => {
				try {
					let response: Response
					if (subject?.source === 'tenant-api') {
						if (!options.tenantTokenUrl || !options.tenantApiUrl) {
							throw new Error('Regional analytics requires a tenant API URL.')
						}
						const tokenResponse = await fetch(options.tenantTokenUrl, {
							signal: controller.signal,
						})
						const tokenPayload = await readJson(tokenResponse)
						if (!tokenResponse.ok || typeof tokenPayload.token !== 'string') {
							const message =
								typeof tokenPayload.message === 'string'
									? tokenPayload.message
									: 'Could not authorize regional analytics.'
							const refusal = refusalError(tokenResponse, message)
							if (refusal) {
								setError(refusal)
								setResult(null)
								return
							}
							throw new Error(message)
						}
						response = await fetch(`${options.tenantApiUrl}/analytics/query`, {
							method: 'POST',
							headers: {
								Authorization: `Bearer ${tokenPayload.token}`,
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({
								definition: options.definition,
								timeZone: viewerTimeZone(),
							}),
							signal: controller.signal,
						})
					} else {
						response = await fetch(options.controlPlaneRunUrl, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								definition: options.definition,
								timeZone: viewerTimeZone(),
							}),
							signal: controller.signal,
						})
					}

					const payload = await readJson(response)
					if (!response.ok) {
						const message =
							typeof payload.message === 'string'
								? payload.message
								: 'Failed to run report.'
						const runError = payload as ReportRunError
						const failure =
							runError.error && runError.message
								? runError
								: refusalError(response, message)
						if (failure) {
							setError(failure)
							setResult(null)
							return
						}
						throw new Error(message)
					}
					if (isReportRunError(payload as ReportResult | ReportRunError)) {
						setError(payload as ReportRunError)
						setResult(null)
						return
					}
					setError(null)
					setResult(payload as ReportResult)
					setUpdatedAt(new Date())
				} catch (caught) {
					if (controller.signal.aborted) return
					setResult(null)
					setError(
						caught instanceof Error ? caught.message : 'Failed to run report.',
					)
				} finally {
					if (!controller.signal.aborted) setLoading(false)
				}
			})()
		}, 250)

		return () => {
			controller.abort()
			window.clearTimeout(timer)
		}
	}, [
		options.catalog,
		options.controlPlaneRunUrl,
		options.definition,
		options.tenantApiUrl,
		options.tenantTokenUrl,
	])

	return { result, error, loading, updatedAt }
}
