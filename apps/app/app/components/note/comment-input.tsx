import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Emoji, gitHubEmojis } from '@tiptap/extension-emoji'
import Mention from '@tiptap/extension-mention'
import Placeholder from '@tiptap/extension-placeholder'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import React, { useEffect, useState } from 'react'

import {
	MediaLibraryPicker,
	type MediaLibraryAsset,
} from '#app/components/media-library/media-library-picker.tsx'

import { CommentImagePreview } from './comment-image-preview'
import { CommentImageUpload } from './comment-image-upload'
import { EmojiPickerButton } from './emoji-picker-button'
import { default as getEmojiSuggestion } from './emoji-suggestions'
import getSuggestions from './suggestions'

export interface MentionUser {
	id: string
	name: string
	email: string
}

interface CommentInputProps {
	users: MentionUser[]
	onSubmit: (
		comment: string,
		images?: File[],
		libraryAssetIds?: string[],
	) => void
	value: string
	className?: string
	variant?: 'default' | 'inline' | 'edit'
	reply?: boolean
	onCancel?: () => void
	placeholder?: string
	disabled?: boolean
	orgSlug?: string
}

const editorChromeClassName =
	'[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-muted-foreground [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]'

const CommentInput: React.FC<CommentInputProps> = ({
	onSubmit,
	value,
	className,
	variant = 'default',
	reply,
	onCancel,
	users,
	placeholder,
	disabled = false,
	orgSlug,
}) => {
	const { _ } = useLingui()
	const [initialValue] = useState(value)
	const [content, setContent] = useState(value)
	const [selectedImages, setSelectedImages] = useState<File[]>([])
	const [selectedLibraryAssets, setSelectedLibraryAssets] = useState<
		MediaLibraryAsset[]
	>([])
	const [isFocused, setIsFocused] = useState(false)
	const isInline = variant === 'inline'
	const isEdit = variant === 'edit'
	const resolvedPlaceholder =
		placeholder ??
		(isInline
			? _(msg`Leave a reply...`)
			: isEdit
				? _(msg`Edit comment...`)
				: _(msg`Add a comment...`))

	const editor = useEditor({
		extensions: [
			StarterKit,
			Placeholder.configure({
				placeholder: resolvedPlaceholder,
			}),
			Mention.configure({
				suggestion: getSuggestions(users),
				HTMLAttributes: {
					class:
						'mention bg-primary/10 text-primary px-1 py-0.5 rounded text-sm font-medium',
				},
			}),
			Emoji.configure({
				emojis: gitHubEmojis,
				enableEmoticons: true,
				suggestion: getEmojiSuggestion(),
			}),
		],
		content: initialValue,
		editorProps: {
			attributes: {
				class:
					'text-sm min-h-5 py-0.5 focus-visible:outline-none max-w-full prose prose-sm max-w-none',
			},
		},
		onUpdate: ({ editor }: { editor: Editor }) => {
			setContent(editor.getHTML())
		},
		onFocus: () => setIsFocused(true),
		onBlur: () => setIsFocused(false),
	})

	useEffect(() => {
		if (editor && value === '') {
			editor.commands.setContent(value)
		}
	}, [editor, value])

	useEffect(() => {
		if (isInline && editor) {
			editor.commands.focus()
		}
	}, [editor, isInline])

	useEffect(() => {
		if (isEdit && editor) {
			editor.commands.focus('end')
		}
	}, [editor, isEdit])

	const handleSubmit = () => {
		if (
			(content.trim() ||
				selectedImages.length > 0 ||
				selectedLibraryAssets.length > 0) &&
			!disabled
		) {
			onSubmit(
				content,
				isEdit ? undefined : selectedImages,
				isEdit ? undefined : selectedLibraryAssets.map((a) => a.id),
			)
			if (!isEdit) {
				editor?.commands.clearContent()
				setContent('')
				setSelectedImages([])
				setSelectedLibraryAssets([])
			}
		}
	}

	const handleImagesSelected = (files: File[]) => {
		setSelectedImages((prev) => {
			const remaining = Math.max(
				0,
				3 - selectedLibraryAssets.length - prev.length,
			)
			return [...prev, ...files.slice(0, remaining)]
		})
	}

	const handleRemoveImage = (index: number) => {
		setSelectedImages((prev) => prev.filter((_, i) => i !== index))
	}

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault()
			handleSubmit()
		}
		if (event.key === 'Escape' && onCancel) {
			event.preventDefault()
			onCancel()
		}
	}

	const handleEmojiSelect = (emoji: string) => {
		if (editor) {
			editor.chain().focus().insertContent(emoji).run()
		}
	}

	const preventToolbarBlur = (event: React.MouseEvent) => {
		event.preventDefault()
	}

	const focusEditor = () => {
		editor?.commands.focus()
	}

	const submitLabel = isEdit ? (
		<Trans>Save</Trans>
	) : reply ? (
		<Trans>Reply</Trans>
	) : (
		<Trans>Comment</Trans>
	)

	const toolbar = (
		<div
			className="flex items-center justify-between gap-2"
			onMouseDown={preventToolbarBlur}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="flex min-w-0 items-center gap-0.5">
				{!isEdit ? (
					<>
						<CommentImageUpload
							onImagesSelected={handleImagesSelected}
							maxImages={
								3 - selectedImages.length - selectedLibraryAssets.length
							}
							disabled={
								disabled ||
								selectedImages.length + selectedLibraryAssets.length >= 3
							}
							className="text-muted-foreground"
						/>
						{orgSlug ? (
							<MediaLibraryPicker
								orgSlug={orgSlug}
								onSelect={(asset) => {
									setSelectedLibraryAssets((prev) =>
										[...prev, asset].slice(0, 3 - selectedImages.length),
									)
								}}
								disabled={
									disabled ||
									selectedImages.length + selectedLibraryAssets.length >= 3
								}
								iconOnly
								variant="ghost"
								className="text-muted-foreground hover:text-foreground hover:bg-accent h-8 w-8 p-0"
							/>
						) : null}
						<EmojiPickerButton
							onEmojiSelect={handleEmojiSelect}
							disabled={disabled}
						/>
						{/* <p className="text-muted-foreground ms-1 truncate text-xs">
							<Trans>@ to mention · ⌘↵ to send</Trans>
						</p> */}
					</>
				) : (
					<EmojiPickerButton
						onEmojiSelect={handleEmojiSelect}
						disabled={disabled}
					/>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{isEdit && onCancel ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={onCancel}
						disabled={disabled}
						className="px-4"
					>
						<Trans>Cancel</Trans>
					</Button>
				) : null}
				<Button
					size="sm"
					disabled={
						(!content.trim() &&
							selectedImages.length === 0 &&
							selectedLibraryAssets.length === 0) ||
						disabled
					}
					onClick={handleSubmit}
					className="px-5"
				>
					{submitLabel}
				</Button>
			</div>
		</div>
	)

	if (isInline) {
		return (
			<div className={cn('relative', className)} onKeyDown={handleKeyDown}>
				{onCancel ? (
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						onClick={onCancel}
						disabled={disabled}
						className="bg-background absolute top-2.5 -left-7 size-6 rounded-full"
						aria-label={_(msg`Cancel reply`)}
					>
						<Icon name="x" className="size-3.5" />
					</Button>
				) : null}

				<div
					className={cn(
						'border-border/80 bg-muted/20 w-full rounded-2xl border px-4 py-2.5 motion-safe:transition-colors',
						editorChromeClassName,
						isFocused && 'border-border bg-muted/40',
					)}
				>
					<EditorContent editor={editor} />
				</div>

				{selectedImages.length > 0 ? (
					<div className="mt-2">
						<CommentImagePreview
							files={selectedImages}
							onRemove={handleRemoveImage}
						/>
					</div>
				) : null}

				{selectedLibraryAssets.length > 0 ? (
					<div className="mt-2 flex flex-wrap gap-2">
						{selectedLibraryAssets.map((asset, index) => (
							<div key={asset.id} className="group relative">
								<div className="bg-muted h-16 w-16 overflow-hidden rounded-lg border">
									<img
										src={asset.url}
										alt={asset.altText ?? ''}
										className="h-full w-full object-cover"
										width={64}
										height={64}
									/>
								</div>
								<Button
									type="button"
									variant="destructive"
									size="sm"
									className="absolute -top-1 -right-1 h-5 w-5 p-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
									onClick={() =>
										setSelectedLibraryAssets((prev) =>
											prev.filter((ignoredA, i) => i !== index),
										)
									}
									aria-label={_(msg`Remove image`)}
								>
									<Icon name="x" className="text-foreground h-3 w-3" />
								</Button>
							</div>
						))}
					</div>
				) : null}

				<div
					className="mt-2 flex items-center justify-between gap-2"
					onMouseDown={preventToolbarBlur}
				>
					<div className="flex min-w-0 items-center gap-0.5">
						<CommentImageUpload
							onImagesSelected={handleImagesSelected}
							maxImages={
								3 - selectedImages.length - selectedLibraryAssets.length
							}
							disabled={
								disabled ||
								selectedImages.length + selectedLibraryAssets.length >= 3
							}
							className="text-muted-foreground"
						/>
						{orgSlug ? (
							<MediaLibraryPicker
								orgSlug={orgSlug}
								onSelect={(asset) => {
									setSelectedLibraryAssets((prev) =>
										[...prev, asset].slice(0, 3 - selectedImages.length),
									)
								}}
								disabled={
									disabled ||
									selectedImages.length + selectedLibraryAssets.length >= 3
								}
								iconOnly
								variant="ghost"
								className="text-muted-foreground hover:text-foreground hover:bg-accent h-8 w-8 p-0"
							/>
						) : null}
						<EmojiPickerButton
							onEmojiSelect={handleEmojiSelect}
							disabled={disabled}
						/>
					</div>
					<Button
						size="sm"
						disabled={
							(!content.trim() &&
								selectedImages.length === 0 &&
								selectedLibraryAssets.length === 0) ||
							disabled
						}
						onClick={handleSubmit}
						className="rounded-full px-4"
					>
						<Trans>Reply</Trans>
					</Button>
				</div>
			</div>
		)
	}

	return (
		<div
			className={cn(
				'border-border/60 bg-muted/40 flex w-full cursor-text flex-col rounded-2xl border p-3 motion-safe:transition-[box-shadow,border-color,background-color]',
				isFocused && 'border-border/80 bg-muted/50 ring-border/30 ring-1',
				className,
			)}
			onClick={focusEditor}
			onKeyDown={handleKeyDown}
		>
			<div
				className={cn(
					editorChromeClassName,
					'[&_.ProseMirror]:min-h-6 [&_.ProseMirror]:outline-none [&_.ProseMirror_p]:my-0 [&_.ProseMirror_p]:leading-normal',
				)}
			>
				<EditorContent editor={editor} />
			</div>

			{selectedImages.length > 0 ? (
				<div className="mt-2">
					<CommentImagePreview
						files={selectedImages}
						onRemove={handleRemoveImage}
					/>
				</div>
			) : null}

			{selectedLibraryAssets.length > 0 ? (
				<div className="mt-2 flex flex-wrap gap-2">
					{selectedLibraryAssets.map((asset, index) => (
						<div key={asset.id} className="group relative">
							<div className="bg-muted h-16 w-16 overflow-hidden rounded-lg border">
								<img
									src={asset.url}
									alt={asset.altText ?? ''}
									className="h-full w-full object-cover"
									width={64}
									height={64}
								/>
							</div>
							<Button
								type="button"
								variant="destructive"
								size="sm"
								className="absolute -top-1 -right-1 h-5 w-5 p-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
								onClick={() =>
									setSelectedLibraryAssets((prev) =>
										prev.filter((ignoredA, i) => i !== index),
									)
								}
								aria-label={_(msg`Remove image`)}
							>
								<Icon name="x" className="text-foreground h-3 w-3" />
							</Button>
						</div>
					))}
				</div>
			) : null}

			<div className="mt-2">{toolbar}</div>
		</div>
	)
}

export default CommentInput
