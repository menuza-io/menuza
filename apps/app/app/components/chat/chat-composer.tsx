import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CHAT_LIMITS } from '@repo/common/chat'
import { normalizeChatMessageBody } from '@repo/common/chat-markdown'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Spinner } from '@repo/ui/spinner'
import { Emoji, gitHubEmojis } from '@tiptap/extension-emoji'
import Placeholder from '@tiptap/extension-placeholder'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
	type FormEvent,
	type KeyboardEvent,
	type MouseEvent,
} from 'react'
import { useFetcher } from 'react-router'
import { Markdown } from 'tiptap-markdown'
import { CommentImagePreview } from '#app/components/note/comment-image-preview.tsx'
import { CommentImageUpload } from '#app/components/note/comment-image-upload.tsx'
import { EmojiPickerButton } from '#app/components/note/emoji-picker-button.tsx'
import getSuggestions from '#app/components/note/suggestions.tsx'
import { CHAT_MENTION_PLUGIN_KEY, ChatMention } from './chat-mention.ts'

export type ChatComposerMember = {
	id: string
	label: string
}

type ChatUploadActionResult =
	{ ok: true; objectKey: string } | { ok: false; error: string }

const editorChromeClassName =
	'[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-muted-foreground [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-start [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]'

function mentionUsers(members: ChatComposerMember[]) {
	return members.map((member) => ({
		id: member.id,
		name: member.label,
		email: '',
	}))
}

function markdownFromEditor(editor: Editor | null) {
	if (!editor) return ''
	const storage = editor.storage as { markdown?: { getMarkdown(): string } }
	const raw = storage.markdown?.getMarkdown
		? storage.markdown.getMarkdown()
		: editor.getText()
	return normalizeChatMessageBody(raw.trim())
}

export function ChatComposer({
	placeholder,
	initialValue = '',
	submitLabel,
	autoFocus,
	disabled,
	members,
	orgSlug,
	onSend,
	onTyping,
	onCancel,
}: {
	placeholder?: string
	initialValue?: string
	submitLabel?: string
	autoFocus?: boolean
	disabled?: boolean
	members: ChatComposerMember[]
	orgSlug: string
	onSend(body: string, attachmentKeys?: string[]): Promise<void>
	onTyping?(): void
	onCancel?(): void
}) {
	const { _ } = useLingui()
	const resolvedPlaceholder = placeholder ?? _(msg`Write a message…`)
	const hintId = useId()
	const errorId = useId()
	const placeholderRef = useRef(resolvedPlaceholder)
	placeholderRef.current = resolvedPlaceholder
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [images, setImages] = useState<File[]>([])
	const [uploading, setUploading] = useState(false)
	const [isFocused, setIsFocused] = useState(false)
	const [hasDraft, setHasDraft] = useState(Boolean(initialValue.trim()))
	const uploadFetcher = useFetcher<ChatUploadActionResult>()
	const uploadWaitRef = useRef<{
		resolve: (objectKey: string) => void
		reject: (error: Error) => void
	} | null>(null)
	const mentionList = useRef(members)
	mentionList.current = members
	const uploadAction = `/${encodeURIComponent(orgSlug)}/chat/upload`

	useEffect(() => {
		if (uploadFetcher.state !== 'idle' || !uploadWaitRef.current) return
		const data = uploadFetcher.data
		const pending = uploadWaitRef.current
		uploadWaitRef.current = null
		if (!data) {
			pending.reject(new Error(_(msg`Could not upload image. Try again.`)))
			return
		}
		if (data.ok && data.objectKey) {
			pending.resolve(data.objectKey)
			return
		}
		pending.reject(
			new Error(
				data.ok === false ? data.error : _(msg`Could not upload image.`),
			),
		)
	}, [uploadFetcher.state, uploadFetcher.data, _])

	const uploadOne = useCallback(
		(file: File) => {
			if (uploadFetcher.state !== 'idle') {
				return Promise.reject(new Error(_(msg`Upload already in progress.`)))
			}
			return new Promise<string>((resolve, reject) => {
				uploadWaitRef.current = { resolve, reject }
				const form = new FormData()
				form.append('file', file)
				void uploadFetcher.submit(form, {
					method: 'POST',
					action: uploadAction,
					encType: 'multipart/form-data',
				})
			})
		},
		[uploadAction, uploadFetcher, _],
	)

	const editor = useEditor({
		immediatelyRender: false,
		extensions: [
			StarterKit.configure({ heading: false }),
			Markdown.configure({ html: false }),
			Placeholder.configure({ placeholder: () => placeholderRef.current }),
			ChatMention.configure({
				suggestion: {
					...getSuggestions(() => mentionUsers(mentionList.current)),
					pluginKey: CHAT_MENTION_PLUGIN_KEY,
				},
				HTMLAttributes: {
					class:
						'mention bg-primary/10 text-primary px-1 py-0.5 rounded text-sm font-medium',
				},
			}),
			Emoji.configure({
				emojis: gitHubEmojis,
				enableEmoticons: true,
			}),
		],
		content: normalizeChatMessageBody(initialValue),
		editorProps: {
			attributes: {
				role: 'textbox',
				'aria-label': resolvedPlaceholder,
				'aria-multiline': 'true',
				'aria-describedby': hintId,
				class:
					'text-base md:text-sm min-h-12 max-h-40 overflow-y-auto focus-visible:outline-none max-w-full prose prose-sm dark:prose-invert max-w-none caret-primary',
			},
		},
		onUpdate: ({ editor: current }) => {
			setHasDraft(current.getText().trim().length > 0)
			onTyping?.()
		},
		onFocus: () => setIsFocused(true),
		onBlur: () => setIsFocused(false),
	})

	useEffect(() => {
		if (autoFocus && editor) editor.commands.focus('end')
	}, [autoFocus, editor])

	useEffect(() => {
		if (!editor) return
		editor.setEditable(!disabled && !pending)
		editor.view.dom.setAttribute('aria-label', resolvedPlaceholder)
		editor.view.dom.setAttribute('aria-invalid', String(Boolean(error)))
		editor.view.dom.setAttribute(
			'aria-describedby',
			error ? `${hintId} ${errorId}` : hintId,
		)
		editor.view.dispatch(editor.state.tr)
	}, [editor, disabled, pending, resolvedPlaceholder, error, hintId, errorId])

	async function uploadImages(): Promise<string[]> {
		if (images.length === 0) return []
		setUploading(true)
		const keys: string[] = []
		try {
			for (const file of images) {
				keys.push(await uploadOne(file))
			}
			return keys
		} finally {
			setUploading(false)
		}
	}

	async function submit(event?: FormEvent) {
		event?.preventDefault()
		if (!editor || pending || disabled || uploading) return
		const body = markdownFromEditor(editor)
		if (!body && images.length === 0) return
		if (body.length > CHAT_LIMITS.bodyMax) {
			setError(_(msg`Message is too long.`))
			return
		}
		setPending(true)
		setError(null)
		try {
			const attachmentKeys = await uploadImages()
			await onSend(body, attachmentKeys.length > 0 ? attachmentKeys : undefined)
			if (!onCancel) {
				editor.commands.clearContent()
				setImages([])
				setHasDraft(false)
				editor.commands.focus()
			}
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: _(msg`Could not send message.`),
			)
		} finally {
			setPending(false)
		}
	}

	function onKeyDown(event: KeyboardEvent) {
		if (editor && CHAT_MENTION_PLUGIN_KEY.getState(editor.state)?.active) return
		if (
			event.key === 'Enter' &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault()
			event.stopPropagation()
			void submit()
		}
		if (event.key === 'Escape' && onCancel) onCancel()
	}

	function preventToolbarBlur(event: MouseEvent) {
		event.preventDefault()
	}

	function focusEditor() {
		editor?.commands.focus()
	}

	const busy = pending || uploading
	const canSend = (hasDraft || images.length > 0) && !busy && !disabled

	return (
		<form onSubmit={submit} className="flex flex-col gap-1.5" aria-busy={busy}>
			<div
				role="group"
				aria-label={_(msg`Message composer`)}
				className={cn(
					'bg-background flex w-full cursor-text flex-col rounded-xl border motion-safe:transition-colors',
					isFocused && 'border-ring',
					disabled && 'bg-muted/40 opacity-60',
				)}
			>
				<div
					className={cn(
						editorChromeClassName,
						'px-4 pt-3 pb-2 [&_.ProseMirror]:outline-none [&_.ProseMirror_p]:my-0 [&_.ProseMirror_p]:leading-relaxed',
					)}
					onClick={focusEditor}
					onKeyDownCapture={onKeyDown}
				>
					<EditorContent editor={editor} />
				</div>

				{images.length > 0 ? (
					<div className="px-4 pb-3">
						<CommentImagePreview
							files={images}
							onRemove={(index) =>
								setImages((current) => current.filter((_, i) => i !== index))
							}
						/>
					</div>
				) : null}

				<div
					className="bg-muted/30 flex items-center justify-between gap-2 rounded-b-xl border-t px-3 py-2"
					onMouseDown={preventToolbarBlur}
				>
					<div className="flex min-w-0 items-center gap-0.5">
						{!onCancel ? (
							<CommentImageUpload
								onImagesSelected={(files) =>
									setImages((current) =>
										[...current, ...files].slice(0, CHAT_LIMITS.attachmentsMax),
									)
								}
								maxImages={CHAT_LIMITS.attachmentsMax - images.length}
								disabled={
									disabled ||
									busy ||
									images.length >= CHAT_LIMITS.attachmentsMax
								}
								className="text-muted-foreground"
							/>
						) : null}
						<EmojiPickerButton
							onEmojiSelect={(emoji) =>
								editor?.chain().focus().insertContent(emoji).run()
							}
							disabled={disabled || busy}
						/>
						{uploading ? (
							<span
								className="text-muted-foreground ms-1 flex items-center gap-1.5 text-xs"
								aria-live="polite"
							>
								<Spinner className="size-3.5" />
								<span className="hidden sm:inline">
									<Trans>Uploading…</Trans>
								</span>
							</span>
						) : null}
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{onCancel ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={onCancel}
								disabled={disabled || busy}
							>
								<Trans>Cancel</Trans>
							</Button>
						) : null}
						<Button
							type="submit"
							size={onCancel ? 'sm' : 'icon'}
							disabled={!canSend}
							aria-label={submitLabel ?? _(msg`Send message`)}
						>
							{busy && !onCancel ? (
								<Spinner className="size-4" />
							) : onCancel ? (
								submitLabel
							) : (
								<Icon name="send" className="size-4" />
							)}
						</Button>
					</div>
				</div>

				{error ? (
					<p
						id={errorId}
						role="alert"
						className="bg-destructive/5 text-destructive border-t px-4 py-3 text-sm"
					>
						{error}
					</p>
				) : null}
			</div>
			<p
				id={hintId}
				className="text-muted-foreground px-1 text-xs max-sm:sr-only"
			>
				<Trans>Enter to send. Shift+Enter for a new line.</Trans>
			</p>
		</form>
	)
}
