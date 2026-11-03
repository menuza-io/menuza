'use client'

import { type ChatAttachment } from '@repo/ai/chat-attachments'
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react'

type PendingMessage = { text: string; files: ChatAttachment[] }

type AIPanelContextValue = {
	isOpen: boolean
	isExpanded: boolean
	hasActivated: boolean
	/** A message waiting for the assistant to take it. */
	pendingMessage: PendingMessage | null
	clearPendingMessage: () => void
	/** Opens the assistant full screen and sends it this message. */
	ask: (text: string, files?: ChatAttachment[]) => void
	open: () => void
	close: () => void
	toggle: () => void
	expand: () => void
	collapse: () => void
	toggleExpanded: () => void
}

const AIPanelContext = createContext<AIPanelContextValue | null>(null)

const STORAGE_KEY = 'ai-panel-open'

export function AIPanelProvider({ children }: { children: ReactNode }) {
	const [isOpen, setIsOpen] = useState(false)
	const [isExpanded, setIsExpanded] = useState(false)
	const [hasActivated, setHasActivated] = useState(false)
	const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(
		null,
	)

	// Restore from localStorage on first mount.
	useEffect(() => {
		try {
			const stored = window.localStorage.getItem(STORAGE_KEY)
			if (stored === 'true') {
				setIsOpen(true)
				setHasActivated(true)
			}
		} catch {
			// localStorage may be unavailable in some contexts; ignore.
		}
	}, [])

	const open = useCallback(() => {
		setIsOpen(true)
		setHasActivated(true)
	}, [])
	const close = useCallback(() => {
		setIsOpen(false)
		setIsExpanded(false)
	}, [])
	const toggle = useCallback(() => {
		setIsOpen((v) => {
			const next = !v
			if (next) setHasActivated(true)
			return next
		})
		setIsExpanded(false)
	}, [])
	const expand = useCallback(() => {
		setIsOpen(true)
		setIsExpanded(true)
		setHasActivated(true)
	}, [])
	const collapse = useCallback(() => setIsExpanded(false), [])
	const clearPendingMessage = useCallback(() => setPendingMessage(null), [])
	const ask = useCallback((text: string, files: ChatAttachment[] = []) => {
		const trimmed = text.trim()
		if (!trimmed && files.length === 0) return
		setPendingMessage({ text: trimmed, files })
		setIsOpen(true)
		setIsExpanded(true)
		setHasActivated(true)
	}, [])
	const toggleExpanded = useCallback(() => {
		setIsExpanded((v) => !v)
	}, [])

	useEffect(() => {
		if (isOpen) setHasActivated(true)
	}, [isOpen])

	useEffect(() => {
		try {
			window.localStorage.setItem(STORAGE_KEY, String(isOpen))
		} catch {
			// ignore
		}
	}, [isOpen])

	const value = useMemo<AIPanelContextValue>(
		() => ({
			isOpen,
			isExpanded,
			hasActivated,
			pendingMessage,
			clearPendingMessage,
			ask,
			open,
			close,
			toggle,
			expand,
			collapse,
			toggleExpanded,
		}),
		[
			isOpen,
			isExpanded,
			hasActivated,
			pendingMessage,
			clearPendingMessage,
			ask,
			open,
			close,
			toggle,
			expand,
			collapse,
			toggleExpanded,
		],
	)

	return (
		<AIPanelContext.Provider value={value}>{children}</AIPanelContext.Provider>
	)
}

export function useAIPanel() {
	const ctx = useContext(AIPanelContext)
	if (!ctx) {
		throw new Error('useAIPanel must be used within AIPanelProvider')
	}
	return ctx
}

/** Toggle the AI panel with ⌘/ or Ctrl+/ */
export function useAIPanelHotkey() {
	const { toggle } = useAIPanel()

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === '/') {
				e.preventDefault()
				toggle()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [toggle])
}
