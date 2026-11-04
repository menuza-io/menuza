'use client'

import { useCallback, useRef, useState } from 'react'
import {
	fileToAttachment,
	MAX_ATTACHMENTS,
	type ChatAttachment,
} from './chat-attachments.js'

/**
 * The attachments of one composer: adding (with room reserved for images
 * still being resized, so two quick selections cannot overshoot the limit),
 * removing, pasting, and whether anything was left out.
 */
export function useChatAttachments() {
	const [attachments, setAttachments] = useState<ChatAttachment[]>([])
	const [error, setError] = useState(false)
	const [resizing, setResizing] = useState(0)
	// Mirrors the state so overlapping additions read the current list.
	const listRef = useRef<ChatAttachment[]>([])
	const reservedRef = useRef(0)

	const commit = useCallback((next: ChatAttachment[]) => {
		listRef.current = next
		setAttachments(next)
	}, [])

	const addFiles = useCallback(
		async (files: File[]) => {
			const room = Math.max(
				0,
				MAX_ATTACHMENTS - listRef.current.length - reservedRef.current,
			)
			const taking = files.slice(0, room)
			let left = files.length - taking.length
			if (taking.length === 0) {
				setError(left > 0)
				return
			}
			reservedRef.current += taking.length
			setResizing((count) => count + 1)
			try {
				const results = await Promise.all(taking.map(fileToAttachment))
				const added = results.filter(
					(result): result is ChatAttachment => result !== null,
				)
				left += taking.length - added.length
				commit([...listRef.current, ...added])
				setError(left > 0)
			} finally {
				reservedRef.current -= taking.length
				setResizing((count) => count - 1)
			}
		},
		[commit],
	)

	const remove = useCallback(
		(id: string) => {
			commit(listRef.current.filter((item) => item.id !== id))
		},
		[commit],
	)

	const clear = useCallback(() => {
		commit([])
		setError(false)
	}, [commit])

	/** Attaches pasted images. Text on the same clipboard still pastes. */
	const onPaste = useCallback(
		(event: React.ClipboardEvent<HTMLTextAreaElement>) => {
			const images = Array.from(event.clipboardData.files).filter((file) =>
				file.type.startsWith('image/'),
			)
			if (images.length === 0) return
			if (!event.clipboardData.getData('text/plain')) event.preventDefault()
			void addFiles(images)
		},
		[addFiles],
	)

	return { attachments, error, resizing, addFiles, remove, clear, onPaste }
}
