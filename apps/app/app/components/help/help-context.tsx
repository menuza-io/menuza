import { msg } from '@lingui/macro'
import { type SupportRequestKind } from '@repo/common/support-requests'
import { useTraceId } from '@repo/common/trace-id'
import { i18n } from '@repo/i18n'
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import { HelpDialog } from './help-dialog.tsx'
import { installGetHelpOnErrorToasts } from './help-toast.ts'

export type OpenHelpOptions = {
	kind?: SupportRequestKind
	/** The reference id of the error the person comes from. */
	errorId?: string | null
}

type HelpContextValue = {
	open: (options?: OpenHelpOptions) => void
}

const HelpContext = createContext<HelpContextValue | null>(null)

/**
 * The Help entry point (#233): one dialog, opened from the account menu, the
 * command menu, an error page and a failed-save toast, with the same context
 * each time. It lives in the signed-in layout, so every page under it can reach
 * Help.
 */
export function HelpProvider({ children }: { children: ReactNode }) {
	const [options, setOptions] = useState<OpenHelpOptions | null>(null)
	const traceId = useTraceId()

	const open = useCallback((next: OpenHelpOptions = {}) => setOptions(next), [])
	const value = useMemo(() => ({ open }), [open])

	// Error toasts get a "Get help" button that attaches this page's reference.
	const openRef = useRef(open)
	openRef.current = open
	const traceRef = useRef(traceId)
	traceRef.current = traceId
	useEffect(
		() =>
			installGetHelpOnErrorToasts(() => ({
				// Read when the toast is shown, so it follows the current language.
				label: i18n._(msg`Get help`),
				onClick: () =>
					openRef.current({ kind: 'problem', errorId: traceRef.current }),
			})),
		[],
	)

	return (
		<HelpContext.Provider value={value}>
			{children}
			{/* Mounted only while open: it needs the translation context and a loader. */}
			{options ? (
				<HelpDialog options={options} onClose={() => setOptions(null)} />
			) : null}
		</HelpContext.Provider>
	)
}

export function useHelp(): HelpContextValue {
	const ctx = useContext(HelpContext)
	if (!ctx) throw new Error('useHelp must be used within HelpProvider')
	return ctx
}

/** For a component that can also render outside the signed-in layout (an error page). */
export function useOptionalHelp(): HelpContextValue | null {
	return useContext(HelpContext)
}
