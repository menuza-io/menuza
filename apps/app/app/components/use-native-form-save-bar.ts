import { useEffect, useRef, useState, type RefObject } from 'react'
import {
	isFailedSave,
	snapshotFormElement,
	useSaveBar,
} from '#app/components/save-bar.tsx'

/**
 * True when any field differs from the value it was rendered with. Reads the
 * DOM defaults (`defaultValue`, `defaultChecked`, `defaultSelected`), which
 * React keeps in step with the `defaultValue`/`defaultChecked` props, so a
 * saved form is clean again as soon as the loader returns the new values.
 */
export function isNativeFormDirty(form: HTMLFormElement) {
	for (const element of Array.from(form.elements)) {
		if (
			element instanceof HTMLInputElement &&
			!element.disabled &&
			element.name
		) {
			if (element.type === 'checkbox' || element.type === 'radio') {
				if (element.checked !== element.defaultChecked) return true
			} else if (
				element.type !== 'submit' &&
				element.type !== 'button' &&
				element.type !== 'file' &&
				element.value !== element.defaultValue
			) {
				return true
			}
		} else if (
			element instanceof HTMLTextAreaElement &&
			!element.disabled &&
			element.value !== element.defaultValue
		) {
			return true
		} else if (element instanceof HTMLSelectElement && !element.disabled) {
			const options = Array.from(element.options)
			// With no default option a single select starts on its first enabled
			// option (and `reset()` restores that), so that is the baseline.
			const implicit =
				!element.multiple && !options.some((option) => option.defaultSelected)
					? options.find((option) => !option.disabled)
					: undefined
			for (const option of options) {
				if (option.selected !== (option.defaultSelected || option === implicit))
					return true
			}
		}
	}
	return false
}

/**
 * Registers a plain uncontrolled `<form>` (no Conform) with the save bar. The
 * form must submit through a fetcher so several forms can save at once; pass
 * `saving` while that fetcher is in flight. Discard resets the fields to their
 * defaults.
 */
export function useNativeFormSaveBar(
	formRef: RefObject<HTMLFormElement | null>,
	saving: boolean,
	options: {
		/** Turn the bar off (for example while a form is in create mode). */
		enabled?: boolean
		/** Edits the DOM cannot show, such as checkbox lists kept in state. */
		extraDirty?: boolean
		/** Resets that state; the fields themselves are reset for you. */
		onDiscard?: () => void
	} = {},
) {
	const { enabled = true, extraDirty = false, onDiscard } = options
	const discardExtra = useRef(onDiscard)
	const [dirty, setDirty] = useState(false)

	const check = useRef(() => {})
	useEffect(() => {
		discardExtra.current = onDiscard
		check.current = () => {
			const form = formRef.current
			setDirty(form ? isNativeFormDirty(form) : false)
		}
		// Re-check after every render: a save changes the defaults, not the
		// fields, and fires no input event.
		check.current()
	})
	useEffect(() => {
		const form = formRef.current
		if (!form) return
		const onChange = () => check.current()
		let resetTimer: ReturnType<typeof setTimeout> | undefined
		const onReset = () => {
			resetTimer = setTimeout(() => check.current(), 0)
		}
		form.addEventListener('input', onChange)
		form.addEventListener('change', onChange)
		form.addEventListener('reset', onReset)
		return () => {
			clearTimeout(resetTimer)
			form.removeEventListener('input', onChange)
			form.removeEventListener('change', onChange)
			form.removeEventListener('reset', onReset)
		}
	}, [formRef])

	useSaveBar({
		dirty: enabled && (dirty || extraDirty),
		saving: enabled && saving,
		onSave: () => formRef.current?.requestSubmit(),
		onDiscard: () => {
			formRef.current?.reset()
			discardExtra.current?.()
			check.current()
		},
	})
}

/**
 * Registers a form whose fields are React state (controlled inputs and hidden
 * inputs that mirror state, as the menu editors use) with the save bar.
 *
 * `useNativeFormSaveBar` compares fields with their DOM defaults, but React
 * keeps a controlled input's default in step with its value, so such a form
 * would always look clean. This compares what the form would submit with what
 * it would have submitted when it opened instead: a new record form is dirty
 * as soon as anything differs from its blank state, and state kept outside
 * inputs counts as long as it is submitted (hidden fields).
 *
 * Until the operator first presses a key or a pointer, changes are taken as
 * the form settling (effects filling derived state), not as edits.
 *
 * Discard calls `onDiscard`, which must restore the opening state (remount the
 * form with a new `key`); the snapshot then matches again.
 */
export function useFormSnapshotSaveBar(
	formRef: RefObject<HTMLFormElement | null>,
	{
		saving,
		result,
		onDiscard,
		enabled = true,
	}: {
		/** True while this form's submission (or the redirect after it) runs. */
		saving: boolean
		/** The latest action data for this form; an `error` keeps it dirty. */
		result?: unknown
		onDiscard: () => void
		enabled?: boolean
	},
) {
	const baseline = useRef<string | null>(null)
	const interacted = useRef(false)
	const [dirty, setDirty] = useState(false)
	const check = useRef(() => {})
	const latest = useRef({ result, onDiscard })
	const submitted = useRef<{ values: string; result: unknown } | null>(null)
	const wasSaving = useRef(false)

	useEffect(() => {
		latest.current = { result, onDiscard }
		check.current = () => {
			const form = formRef.current
			if (!form) {
				setDirty(false)
				return
			}
			const now = snapshotFormElement(form)
			if (baseline.current === null || !interacted.current) {
				baseline.current = now
			}
			setDirty(now !== baseline.current)
		}
		// State-driven fields change on render, not through input events.
		check.current()
	})

	useEffect(() => {
		const form = formRef.current
		if (!form) return
		const onChange = () => check.current()
		const onSubmit = () => {
			submitted.current = {
				values: snapshotFormElement(form),
				result: latest.current.result,
			}
		}
		form.addEventListener('input', onChange)
		form.addEventListener('change', onChange)
		form.addEventListener('submit', onSubmit)
		return () => {
			form.removeEventListener('input', onChange)
			form.removeEventListener('change', onChange)
			form.removeEventListener('submit', onSubmit)
		}
	}, [formRef])

	useEffect(() => {
		// Anywhere on the page: pickers and sheets render in portals.
		const mark = () => {
			interacted.current = true
		}
		document.addEventListener('pointerdown', mark, true)
		document.addEventListener('keydown', mark, true)
		return () => {
			document.removeEventListener('pointerdown', mark, true)
			document.removeEventListener('keydown', mark, true)
		}
	}, [])

	// A save that keeps the page open: adopt what was saved as the new
	// baseline, unless it failed or the fields changed while it ran.
	useEffect(() => {
		const finished = wasSaving.current && !saving
		wasSaving.current = saving
		if (!finished || !submitted.current) return
		const { values, result: resultAtSubmit } = submitted.current
		submitted.current = null
		const form = formRef.current
		const current = latest.current.result
		const fresh = current === undefined || current !== resultAtSubmit
		if (!form || !fresh || isFailedSave(current)) return
		if (snapshotFormElement(form) === values) {
			baseline.current = values
			setDirty(false)
		}
	}, [saving, formRef])

	useSaveBar({
		dirty: enabled && dirty,
		saving: enabled && saving,
		onSave: () => formRef.current?.requestSubmit(),
		onDiscard: () => {
			latest.current.onDiscard()
		},
	})
}

/**
 * State for `useFormSnapshotSaveBar`'s discard: render the form with
 * `key={discardKey}` and pass `discard` as `onDiscard` to remount it with its
 * opening values.
 */
export function useDiscardKey() {
	const [discardKey, setDiscardKey] = useState(0)
	return {
		discardKey,
		discard: () => setDiscardKey((key) => key + 1),
	}
}
