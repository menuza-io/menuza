import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { usePostHog } from '@posthog/react'
import { getErrorMessage } from '@repo/common'
import { useTraceId } from '@repo/common/trace-id'
import { Button } from '@repo/ui/button'
import { ErrorReference } from '@repo/ui/error-reference'
import { NotFoundPage } from '@repo/ui/not-found-page'
import {
	createContext,
	useContext,
	useEffect,
	type ReactElement,
	type ReactNode,
} from 'react'
import {
	type ErrorResponse,
	isRouteErrorResponse,
	useParams,
	useRouteError,
} from 'react-router'
import { useOptionalHelp } from '#app/components/help/help-context.tsx'

type StatusHandler = (info: {
	error: ErrorResponse
	params: Record<string, string | undefined>
}) => ReactElement | null

const InAppShellContext = createContext(false)

/**
 * The reference id of this page load (#385) with a Copy button, shown under
 * every error so an owner can read it to support. The same id is on the server
 * log line and on the error report.
 */
export function ErrorReferenceBlock({ className }: { className?: string }) {
	const traceId = useTraceId()
	// Outside a page load with a reference (a unit test, a bare render) there is
	// nothing to show, and nothing here needs the translation context.
	if (!traceId) return null
	return <ErrorReferenceBody traceId={traceId} className={className} />
}

function ErrorReferenceBody({
	traceId,
	className,
}: {
	traceId: string
	className?: string
}) {
	const help = useOptionalHelp()
	const { _ } = useLingui()
	return (
		<div className="flex flex-col items-center gap-3">
			<ErrorReference
				traceId={traceId}
				className={className}
				labels={{
					reference: _(msg`Reference`),
					copy: _(msg`Copy reference`),
					copied: _(msg`Copied`),
					copyFailed: _(msg`Press Ctrl+C or Cmd+C to copy`),
				}}
			/>
			{help ? (
				<Button
					type="button"
					onClick={() => help.open({ kind: 'problem', errorId: traceId })}
				>
					<Trans>Get help</Trans>
				</Button>
			) : null}
		</div>
	)
}

// The App shell (sidebar and header) wraps its Outlet in this, so a route
// error inside it can fill the content area instead of the whole screen.
export function AppShellErrorScope({ children }: { children: ReactNode }) {
	return (
		<InAppShellContext.Provider value={true}>
			{children}
		</InAppShellContext.Provider>
	)
}

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
	const inAppShell = useContext(InAppShellContext)
	const traceId = useTraceId()

	if (typeof document !== 'undefined') {
		console.error(error)
	}

	useEffect(() => {
		if (isResponse) return

		// The same reference the page shows and the server logged (#385).
		posthog?.captureException(error, { trace_id: traceId ?? undefined })
		posthog?.logger.error('Unhandled React route error', {
			path: window.location.pathname,
		})
	}, [error, isResponse, posthog, traceId])

	// A route without its own 404 handler (for example Staff while the module
	// is off) gets the not-found page. Inside the App shell it fills the
	// content area; elsewhere (the auth pages) it is a standalone page.
	if (isResponse && error.status === 404 && !statusHandlers?.[404]) {
		return <NotFoundPage variant={inAppShell ? 'inline' : 'screen'} />
	}

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
			<ErrorReferenceBlock />
		</div>
	)
}

// The App-wide last-resort boundary: a 404 (for example an unknown
// organization slug) gets a page with a way back into the app, and everything
// else keeps the default status text. NotFoundPage is a full-screen layout, so
// it is not wrapped in GeneralErrorBoundary's padded container.
export function NotFoundErrorBoundary() {
	const error = useRouteError()
	if (isRouteErrorResponse(error) && error.status === 404) {
		if (typeof document !== 'undefined') console.error(error)
		return <NotFoundPage />
	}
	return <GeneralErrorBoundary />
}
