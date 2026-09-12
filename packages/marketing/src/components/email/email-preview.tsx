import { Trans } from '@lingui/macro'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { useCallback, useMemo, useRef, useState } from 'react'

/** Width the email is authored at; scaled down to fit narrower preview panes. */
const EMAIL_PREVIEW_WIDTH = 600

/**
 * The application CSP intentionally limits iframe images to the app origin.
 * Keep that policy intact and route only external preview images through the
 * existing same-origin image proxy. This is preview-only; sent email HTML is
 * never rewritten.
 */
function rewriteExternalImageSources(html: string) {
	if (typeof DOMParser === 'undefined') return html

	const document = new DOMParser().parseFromString(html, 'text/html')
	for (const image of document.images) {
		const source = image.getAttribute('src')
		if (!source) continue

		let sourceUrl: URL
		try {
			sourceUrl = new URL(source, window.location.href)
		} catch {
			continue
		}

		if (
			(sourceUrl.protocol !== 'http:' && sourceUrl.protocol !== 'https:') ||
			sourceUrl.origin === window.location.origin
		) {
			continue
		}

		image.src = `/resources/images?src=${encodeURIComponent(sourceUrl.href)}`
	}

	return document.documentElement.outerHTML
}

export type EmailPreviewProps = {
	html: string
	loading?: boolean
	/**
	 * Draw the card chrome (border, radius, shadow). Turn off when a parent
	 * surface already provides it, so borders don't nest.
	 */
	framed?: boolean
	className?: string
}

/**
 * Renders the server-produced email HTML in a sandboxed iframe.
 *
 * The iframe always lays the email out at `EMAIL_PREVIEW_WIDTH` and is
 * CSS-scaled down to the available width, so the preview never clips (a plain
 * `width: 100%` iframe renders the 600px email into a narrower box and hides the
 * overflow). The wrapper height is adjusted for the scale so the surrounding
 * panel scrolls naturally.
 */
export function EmailPreview({
	html,
	loading = false,
	framed = true,
	className,
}: EmailPreviewProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const [scale, setScale] = useState(1)
	const [contentHeight, setContentHeight] = useState(480)
	const previewHtml = useMemo(() => rewriteExternalImageSources(html), [html])

	const setContainerRef = useCallback((element: HTMLDivElement | null) => {
		if (!element) return
		const measure = () => {
			const available = element.clientWidth
			if (available <= 0) return
			setScale(Math.min(1, available / EMAIL_PREVIEW_WIDTH))
		}

		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(element)
		return () => observer.disconnect()
	}, [])

	const handleLoad = () => {
		const doc = iframeRef.current?.contentDocument
		if (!doc?.body) return
		// `documentElement.scrollHeight` never shrinks below the iframe's own
		// height, so measuring it leaves a growing empty gap. The body height is
		// the real content height.
		const measured = Math.ceil(
			Math.max(doc.body.getBoundingClientRect().height, doc.body.scrollHeight),
		)
		if (measured > 0) setContentHeight(measured)
	}

	const header = (
		<div className="border-border flex items-center gap-2 border-b px-4 py-2.5">
			<Icon name="mail" className="text-muted-foreground size-3.5" />
			<span className="text-muted-foreground text-xs font-medium">
				<Trans>Email preview</Trans>
			</span>
			{loading ? (
				<span className="text-muted-foreground ml-auto text-[11px]">
					<Trans>Rendering…</Trans>
				</span>
			) : null}
		</div>
	)

	const surface = (
		<div ref={setContainerRef} className="w-full overflow-hidden">
			{previewHtml ? (
				<div style={{ height: contentHeight * scale }}>
					<iframe
						ref={iframeRef}
						title="Email preview"
						srcDoc={previewHtml}
						onLoad={handleLoad}
						sandbox="allow-same-origin"
						className="border-0"
						style={{
							width: EMAIL_PREVIEW_WIDTH,
							height: contentHeight,
							transform: `scale(${scale})`,
							transformOrigin: 'top left',
						}}
					/>
				</div>
			) : (
				<div className="text-muted-foreground flex h-[420px] items-center justify-center px-6 text-center text-sm">
					<Trans>Add a block to see your email come to life.</Trans>
				</div>
			)}
		</div>
	)

	// Unframed: the parent surface supplies the chrome, so this fills the pane
	// and centres the email at its authored width.
	if (!framed) {
		return (
			<div className={cn('flex h-full min-h-0 w-full flex-col', className)}>
				{header}
				<div className="flex min-h-0 flex-1 justify-center overflow-auto p-4 sm:p-6">
					<div className="w-full max-w-[600px]">{surface}</div>
				</div>
			</div>
		)
	}

	return (
		// Cap at the authored email width so the card wraps the email instead of
		// stretching to fill a wide pane (which would strand empty space beside
		// the 600px frame).
		<div className={cn('mx-auto w-full max-w-[600px]', className)}>
			<div className="bg-background overflow-hidden rounded-2xl border shadow-sm">
				{header}
				<div className="bg-background">{surface}</div>
			</div>
		</div>
	)
}
