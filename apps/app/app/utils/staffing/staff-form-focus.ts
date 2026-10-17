/** Wait for inline errors to render before focusing the first invalid control. */
export function focusFirstInvalidField(form: HTMLFormElement) {
	requestAnimationFrame(() => {
		if (form.isConnected) {
			form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
		}
	})
}
