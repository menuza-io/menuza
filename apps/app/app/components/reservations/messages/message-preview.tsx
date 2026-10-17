import { Trans, useLingui } from '@lingui/react/macro'
import { Icon } from '@repo/ui/icon'
import { useEffect, useState } from 'react'
import {
	fetchMessagePreview,
	type MessageLocale,
	type MessagePreview as MessagePreviewData,
} from '#app/utils/reservations/messages-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { extractApiErrorMessage } from '#app/utils/reservations/setup-api.ts'

const PREVIEW_DEBOUNCE_MS = 250

/**
 * Sample email and SMS rendered by tenant-api from the saved settings. The HTML
 * goes into a script-less sandboxed frame; it is never injected into this page.
 */
export function MessagePreview({
	client,
	locationId,
	kind,
	locale,
	refreshKey,
}: {
	client: ReservationsScopedClient
	locationId: string
	kind: string
	locale: MessageLocale
	/** Changes when the saved settings change, so the preview is fetched again. */
	refreshKey: number
}) {
	const { t } = useLingui()
	const [preview, setPreview] = useState<MessagePreviewData | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const controller = new AbortController()
		setLoading(true)
		setError(null)
		const timer = setTimeout(() => {
			fetchMessagePreview(
				client,
				locationId,
				{ kind, locale },
				controller.signal,
			)
				.then((next) => {
					if (controller.signal.aborted) return
					setPreview(next)
					setLoading(false)
				})
				.catch((err: unknown) => {
					if (controller.signal.aborted) return
					setError(
						extractApiErrorMessage(err, t`The preview could not be loaded.`),
					)
					setLoading(false)
				})
		}, PREVIEW_DEBOUNCE_MS)
		return () => {
			clearTimeout(timer)
			controller.abort()
		}
	}, [client, locationId, kind, locale, refreshKey, t])

	return (
		<div
			className="flex flex-col gap-3"
			aria-busy={loading}
			data-testid="message-preview"
		>
			{error ? (
				<p
					role="alert"
					className="text-destructive text-sm"
					data-testid="message-preview-error"
				>
					{error}
				</p>
			) : null}
			{loading && !preview ? (
				<div
					className="text-muted-foreground flex items-center gap-2 text-sm"
					role="status"
					data-testid="message-preview-loading"
				>
					<Icon name="loader" aria-hidden className="size-4 animate-spin" />
					<Trans>Loading preview…</Trans>
				</div>
			) : null}
			{preview ? (
				<div
					className={
						loading ? 'flex flex-col gap-3 opacity-60' : 'flex flex-col gap-3'
					}
				>
					<div className="flex flex-col gap-1">
						<span className="text-muted-foreground text-xs font-medium">
							<Trans>Email subject</Trans>
						</span>
						<p
							className="text-sm font-medium wrap-anywhere"
							dir={locale === 'ar' ? 'rtl' : 'ltr'}
							data-testid="message-preview-subject"
						>
							{preview.subject}
						</p>
					</div>
					<iframe
						title={t`Sample email preview`}
						sandbox=""
						referrerPolicy="no-referrer"
						srcDoc={preview.html}
						className="bg-card h-96 w-full rounded-md border"
						data-testid="message-preview-frame"
					/>
					{preview.sms ? (
						<div className="flex flex-col gap-1">
							<span className="text-muted-foreground text-xs font-medium">
								<Trans>Sample text message</Trans>
							</span>
							<p
								className="bg-muted rounded-md px-3 py-2 text-sm wrap-anywhere"
								dir={locale === 'ar' ? 'rtl' : 'ltr'}
								data-testid="message-preview-sms"
							>
								{preview.sms}
							</p>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	)
}
