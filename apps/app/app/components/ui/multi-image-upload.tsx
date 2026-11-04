import {
	getFieldsetProps,
	getInputProps,
	useForm,
	type FieldMetadata,
} from '@conform-to/react'
import { t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { getNoteImgSrc } from '@repo/common'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import React, { useState, useRef, useCallback } from 'react'
import { type ImageFieldset } from '#app/routes/_app+/$orgSlug_+/__org-note-editor.tsx'
import { useDragAndDrop } from './use-drag-and-drop.tsx'
import { createFileInputRef } from './use-file-input-ref.tsx'

interface MultiImageUploadProps {
	label?: string
	maxImages?: number
	className?: string
	disabled?: boolean
	meta: FieldMetadata<(ImageFieldset | null)[] | null>
	formId: string
	existingImages?: Array<{
		id: string
		altText: string | null
		objectKey: string
	}>
	organizationId: string
}

export function MultiImageUpload({
	label = 'Images',
	maxImages = 5,
	className,
	disabled = false,
	meta,
	formId,
	existingImages = [],
	organizationId,
}: MultiImageUploadProps) {
	const fileInputRef = useRef<HTMLInputElement>(null)
	const [form] = useForm({ id: formId })
	const imageList = meta.getFieldList()

	// Store preview URLs and files for each image key
	const [previewUrls, setPreviewUrls] = useState<Map<string, string>>(new Map())
	const [fileRefs, setFileRefs] = useState<Map<string, File>>(new Map())

	const metaName = meta.name!

	// Convert File to data URL synchronously and handle insertion
	const handleFileUpload = useCallback(
		(file: File) => {
			// First convert the file to a data URL
			const reader = new FileReader()

			reader.onload = (event) => {
				if (typeof event.target?.result !== 'string') {
					return
				}

				const dataUrl = event.target.result

				// Insert into form after we have the data URL
				form.insert({
					name: metaName,
					defaultValue: { file },
				})

				// Get the latest form list after insertion
				const updatedList = meta.getFieldList()
				const newEntry = updatedList[updatedList.length - 1]

				if (newEntry) {
					const key = newEntry.key as string

					// Store both preview URL and file reference with the key from the newly inserted field
					setPreviewUrls((prev) => {
						const newMap = new Map(prev)
						newMap.set(key, dataUrl)
						return newMap
					})
					setFileRefs((prev) => {
						const newMap = new Map(prev)
						newMap.set(key, file)
						return newMap
					})
				}
			}

			// Start the file reading process
			reader.readAsDataURL(file)
		},
		[form, metaName, meta],
	)

	const { isDragging, handleDragOver, handleDragLeave, handleDrop } =
		useDragAndDrop({
			disabled,
			onFileUpload: handleFileUpload,
			acceptFilter: (file) => file.type.startsWith('image/'),
		})

	const handleClick = () => {
		if (!disabled && fileInputRef.current) {
			fileInputRef.current.click()
		}
	}

	const canAddMore = imageList.length < maxImages && !disabled

	return (
		<div className={cn('mt-4 space-y-4', className)}>
			<FieldLabel className="text-sm font-medium">
				{label} ({imageList.length}/{maxImages})
			</FieldLabel>

			{/* Existing Images Grid */}
			{imageList.length > 0 && (
				<div className="flex h-32 gap-4">
					{imageList.map((imageMeta, index) => {
						// Find existing image data by matching form field ID
						const imageMetaId = imageMeta.getFieldset().id.value
						const key = imageMeta.key as string
						const existingImage = existingImages.find(
							({ id }) => id === imageMetaId,
						)
						return (
							<ImagePreview
								key={key}
								meta={imageMeta}
								previewUrl={previewUrls.get(key)}
								file={fileRefs.get(key)}
								existingImage={existingImage}
								organizationId={organizationId}
								onRemove={() => {
									// Remove preview URL and file ref first
									setPreviewUrls((prev) => {
										const newMap = new Map(prev)
										newMap.delete(key)
										return newMap
									})
									setFileRefs((prev) => {
										const newMap = new Map(prev)
										newMap.delete(key)
										return newMap
									})
									// Then remove from form
									form.remove({ name: metaName, index })
								}}
								disabled={disabled}
							/>
						)
					})}
				</div>
			)}

			{/* Upload Area */}
			{canAddMore && (
				<div
					className={cn(
						'cursor-pointer rounded-lg border-2 border-dashed transition-[border-color,background-color] duration-180',
						isDragging ? 'border-primary bg-primary/5' : 'hover:border-primary',
					)}
					onDragOver={handleDragOver}
					onDragLeave={handleDragLeave}
					onDrop={handleDrop}
					onClick={handleClick}
				>
					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						multiple
						onChange={(e) => {
							const files = Array.from(e.target.files || [])
							for (const file of files) {
								handleFileUpload(file)
							}
							// clear the input value so the user can select the same file again
							e.currentTarget.value = ''
						}}
						className="hidden"
						disabled={disabled}
					/>
					<div className="p-8 text-center">
						<div className="space-y-4">
							<div className="bg-muted mx-auto flex h-12 w-12 items-center justify-center rounded-full">
								<Icon name="plus" className="h-6 w-6" />
							</div>
							<div className="space-y-2">
								<p className="text-sm font-medium">
									{isDragging ? 'Drop images here' : 'Add more images'}
								</p>
								<p className="text-muted-foreground text-xs">
									Or click to select files
								</p>
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	)
}

function ImagePreview({
	meta,
	previewUrl,
	file,
	existingImage,
	organizationId,
	onRemove,
	disabled,
}: {
	meta: FieldMetadata<ImageFieldset | null>
	previewUrl?: string
	file?: File
	existingImage?: {
		id: string
		altText: string | null
		objectKey: string
	}
	organizationId: string
	onRemove: () => void
	disabled?: boolean
}) {
	const { _ } = useLingui()
	const fields = meta.getFieldset()

	// Handle existing images using the passed existingImage data
	const existingImageUrl = existingImage?.objectKey
		? getNoteImgSrc(existingImage.objectKey, organizationId)
		: null

	const imageUrl = existingImageUrl ?? previewUrl

	return (
		<fieldset
			{...getFieldsetProps(meta)}
			className="group relative aspect-square"
		>
			<input {...getInputProps(fields.id, { type: 'hidden' })} />
			<label
				htmlFor={fields.file.id}
				className={cn('group absolute size-32 rounded-lg', {
					'bg-accent opacity-40 focus-within:opacity-100 hover:opacity-100':
						!imageUrl,
					'cursor-pointer focus-within:ring-2': !existingImageUrl,
				})}
			>
				{imageUrl ? (
					<img
						src={imageUrl}
						alt={fields.altText.initialValue ?? ''}
						className="size-32 rounded-lg object-cover"
					/>
				) : (
					<div className="border-muted-foreground text-muted-foreground flex size-32 items-center justify-center rounded-lg border text-4xl">
						<Icon name="plus" />
					</div>
				)}
			</label>
			<input
				aria-label={_(t`Image`)}
				className="absolute top-0 left-0 z-0 size-32 cursor-pointer opacity-0"
				accept="image/*"
				{...getInputProps(fields.file, { type: 'file' })}
				ref={createFileInputRef(file)}
			/>
			<div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
				<Button
					type="button"
					variant="destructive"
					size="sm"
					onClick={onRemove}
					disabled={disabled}
					aria-label={_(t`Remove image`)}
				>
					<Icon name="x" className="h-4 w-4" />
				</Button>
			</div>
		</fieldset>
	)
}
