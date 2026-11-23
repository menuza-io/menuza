import * as React from 'react'

import { cn } from '../lib/utils'
import { Button } from './ui/button'

export type ErrorReferenceLabels = {
	/** "Reference" */
	reference: string
	/** "Copy reference" */
	copy: string
	/** "Copied" */
	copied: string
	/** Spoken when copying is not possible (the id is selected instead). */
	copyFailed: string
}

export const DEFAULT_ERROR_REFERENCE_LABELS: ErrorReferenceLabels = {
	reference: 'Reference',
	copy: 'Copy reference',
	copied: 'Copied',
	copyFailed: 'Press Ctrl+C or Cmd+C to copy',
}

/**
 * The reference id of a failed page load (#385), with a Copy button. The
 * button is a native `<button>`: Tab reaches it and Enter or Space copies. The
 * result is announced in a polite live region so it works without a mouse or a
 * screen. When the clipboard is blocked the id is selected for a manual copy.
 */
export function ErrorReference({
	traceId,
	labels = DEFAULT_ERROR_REFERENCE_LABELS,
	className,
}: {
	traceId: string
	labels?: ErrorReferenceLabels
	className?: string
}) {
	const codeRef = React.useRef<HTMLElement>(null)
	const [status, setStatus] = React.useState<'idle' | 'copied' | 'failed'>(
		'idle',
	)

	React.useEffect(() => {
		if (status === 'idle') return
		const timer = setTimeout(() => setStatus('idle'), 2500)
		return () => clearTimeout(timer)
	}, [status])

	async function copy() {
		try {
			await navigator.clipboard.writeText(traceId)
			setStatus('copied')
		} catch {
			const node = codeRef.current
			if (node) {
				const range = document.createRange()
				range.selectNodeContents(node)
				const selection = window.getSelection()
				selection?.removeAllRanges()
				selection?.addRange(range)
			}
			setStatus('failed')
		}
	}

	return (
		<div
			className={cn(
				'text-muted-foreground flex flex-wrap items-center gap-2 text-sm',
				className,
			)}
			data-slot="error-reference"
		>
			<span>{labels.reference}</span>
			<code
				ref={codeRef}
				className="bg-muted text-foreground rounded px-1.5 py-0.5 font-mono text-xs select-all"
				data-testid="error-reference-id"
			>
				{traceId}
			</code>
			<Button type="button" variant="outline" size="sm" onClick={copy}>
				{status === 'copied' ? labels.copied : labels.copy}
			</Button>
			<span className="sr-only" role="status" aria-live="polite">
				{status === 'copied'
					? labels.copied
					: status === 'failed'
						? labels.copyFailed
						: ''}
			</span>
		</div>
	)
}
