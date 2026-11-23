import { toast } from 'sonner'

type ToastApi = {
	error: (message: unknown, data?: Record<string, unknown>) => unknown
}

const PATCHED = Symbol.for('menuza.getHelpOnErrorToasts')

/**
 * Gives every error toast a "Get help" button that opens the support form with
 * the page's error reference attached (#233). A failed save is an error toast
 * wherever it comes from (a server flash or a client `toast.error`), so this
 * wraps `toast.error` once instead of editing every call site. A toast that
 * already has its own action keeps it. Returns the function that restores the
 * original.
 */
export function installGetHelpOnErrorToasts(
	getAction: () => { label: string; onClick: () => void } | null,
	api: ToastApi = toast as unknown as ToastApi,
): () => void {
	const target = api as ToastApi & { [PATCHED]?: ToastApi['error'] }
	// Replace an earlier wrapper rather than stacking a second one.
	const original = target[PATCHED] ?? target.error
	target[PATCHED] = original
	target.error = (message, data) => {
		const action = getAction()
		const own = data && (data.action !== undefined || data.cancel !== undefined)
		return original(message, action && !own ? { ...data, action } : data)
	}
	return () => {
		target.error = original
		delete target[PATCHED]
	}
}
