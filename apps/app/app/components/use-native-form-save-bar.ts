import { useEffect, useRef, useState, type RefObject } from 'react'
import { useSaveBar } from '#app/components/save-bar.tsx'

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
