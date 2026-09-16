import { usePostHog } from '@posthog/react'
import { getErrorMessage } from '@repo/common'
import { useEffect, type ReactElement } from 'react'
import {
	type ErrorResponse,
	isRouteErrorResponse,
	useParams,
	useRouteError,
} from 'react-router'

type StatusHandler = (info: {
	error: ErrorResponse
	params: Record<string, string | undefined>
}) => ReactElement | null

export function GeneralErrorBoundary({
	defaultStatusHandler = ({ error }) => (
		<p>
			{error.status} {error.data}
		</p>
	),
	statusHandlers,
	unexpectedErrorHandler = (error) => <p>{getErrorMessage(error)}</p>,
}: {
	defaultStatusHandler?: StatusHandler
	statusHandlers?: Record<number, StatusHandler>
	unexpectedErrorHandler?: (error: unknown) => ReactElement | null
}) {
	const error = useRouteError()
	const posthog = usePostHog()
	const params = useParams()
	const isResponse = isRouteErrorResponse(error)

	if (typeof document !== 'undefined') {
		console.error(error)
	}

	useEffect(() => {
		if (isResponse) return

		posthog?.captureException(error)
		posthog?.logger.error('Unhandled React route error', {
			path: window.location.pathname,
		})
	}, [error, isResponse, posthog])

	return (
		<div className="container flex items-center justify-center p-20 text-2xl">
			{isResponse
				? (statusHandlers?.[error.status] ?? defaultStatusHandler)({
						error,
						params,
					})
				: unexpectedErrorHandler(error)}
		</div>
	)
}
