import { getErrorMessage } from '@repo/common'
import { useTraceId } from '@repo/common/trace-id'
import { ErrorReference } from '@repo/ui/error-reference'
import { type ReactElement } from 'react'
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
	const params = useParams()
	const isResponse = isRouteErrorResponse(error)

	if (typeof document !== 'undefined') {
		console.error(error)
	}

	// The reference id of this page load (#385): the same value is on the server
	// log line, so it can be pasted into Request lookup.
	const traceId = useTraceId()

	return (
		<div className="container flex flex-col items-center justify-center gap-6 p-20">
			<div className="text-2xl">
				{isResponse
					? (statusHandlers?.[error.status] ?? defaultStatusHandler)({
							error,
							params,
						})
					: unexpectedErrorHandler(error)}
			</div>
			{traceId ? <ErrorReference traceId={traceId} /> : null}
		</div>
	)
}
