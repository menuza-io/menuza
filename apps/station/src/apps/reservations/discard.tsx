import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, IconButton } from '~/ui/primitives.tsx'

/**
 * A form that holds something typed is not thrown away by a stray tap on the
 * backdrop. While `dirty`, the sheet is not dismissible by the backdrop or
 * Escape on their own: the close button and Escape ask first ("Discard this
 * booking?  Keep editing | Discard"), and the ask replaces the sheet's actions
 * so it is the one thing to answer. A clean form closes at once, as before.
 *
 * The modal draws its own close button only while it is dismissible, so a dirty
 * form draws `DiscardClose` in its place.
 */
export function useDiscardGuard({
	open,
	dirty,
	onClose,
}: {
	open: boolean
	dirty: boolean
	onClose: () => void
}) {
	const [asking, setAsking] = useState(false)
	// A sheet that closes (or is reopened) starts without the ask.
	useEffect(() => {
		if (!open) setAsking(false)
	}, [open])
	// Nothing left to lose: the ask is moot.
	useEffect(() => {
		if (!dirty) setAsking(false)
	}, [dirty])

	/** The close button or Escape: close a clean form, ask about a dirty one. */
	const requestClose = useCallback(() => {
		if (dirty) setAsking(true)
		else onClose()
	}, [dirty, onClose])
	const keep = useCallback(() => setAsking(false), [])
	const discard = useCallback(() => {
		setAsking(false)
		onClose()
	}, [onClose])

	// Escape asks (and, with the ask showing, goes back to the form). The modal
	// itself ignores Escape while it is not dismissible.
	useEffect(() => {
		if (!open || !dirty) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			event.preventDefault()
			if (asking) keep()
			else requestClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [open, dirty, asking, keep, requestClose])

	return {
		/** For the modal: false while the form holds something. */
		dismissible: !dirty,
		asking,
		requestClose,
		keep,
		discard,
	}
}

/** The close button of a sheet that is not dismissible: where the modal's own would be. */
export function DiscardClose({ onClick }: { onClick: () => void }) {
	const { _ } = useLingui()
	return (
		<IconButton
			label={_(msg`Close`)}
			onClick={onClick}
			className="absolute end-3 top-2 z-10"
		>
			<X className="size-5" />
		</IconButton>
	)
}

/** The footer of a sheet being asked about: the question, and the two answers. */
export function DiscardAsk({
	question,
	onKeep,
	onDiscard,
}: {
	question: ReactNode
	onKeep: () => void
	onDiscard: () => void
}) {
	return (
		<div className="mb-safe flex flex-col gap-3">
			<p role="status" className="font-medium">
				{question}
			</p>
			<div className="grid grid-cols-2 gap-3">
				<Button size="lg" autoFocus onClick={onKeep}>
					<Trans>Keep editing</Trans>
				</Button>
				<Button variant="danger" size="lg" onClick={onDiscard}>
					<Trans>Discard</Trans>
				</Button>
			</div>
		</div>
	)
}
