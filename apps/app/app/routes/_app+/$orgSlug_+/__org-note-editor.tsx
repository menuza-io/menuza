import {
	FormProvider,
	getFormProps,
	getInputProps,
	useForm,
} from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { AIContentGenerator } from '@repo/ai'
import { useIsPending } from '@repo/common'
import { Button } from '@repo/ui/button'
import { Field, FieldLabel, FieldError } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { StatusButton } from '@repo/ui/status-button'
import { useEffect, useState, useRef, lazy, Suspense, Component } from 'react'
import { useFetcher, useParams } from 'react-router'
import { z } from 'zod'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	ErrorList,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'
import {
	ContentEditor,
	type ContentEditorRef,
} from '#app/components/note/content-editor.tsx'

// Simple error boundary for lazy-loaded components
class LazyLoadErrorBoundary extends Component<
	{ children: React.ReactNode; fallback: React.ReactNode },
	{ hasError: boolean }
> {
	constructor(props: { children: React.ReactNode; fallback: React.ReactNode }) {
		super(props)
		this.state = { hasError: false }
	}

	static getDerivedStateFromError() {
		return { hasError: true }
	}

	render() {
		if (this.state.hasError) {
			return this.props.fallback
		}
		return this.props.children
	}
}

// Lazy load MultiMediaUpload component for better performance
const MultiMediaUpload = lazy(() =>
	import('#app/components/ui/multi-media-upload.tsx').then((module) => ({
		default: module.MultiMediaUpload,
	})),
)

const titleMinLength = 1
const titleMaxLength = 100
const contentMinLength = 1
const contentMaxLength = 20000 // Increased to account for HTML markup

export const MAX_UPLOAD_SIZE = 1024 * 1024 * 3 // 3MB

const ImageFieldsetSchema = z.object({
	id: z.string().optional(),
	mediaId: z.string().optional(),
	fileId: z.string().optional(), // Added to store unique file identifier
	file: z
		.any()
		.optional()
		.refine(
			(file) =>
				!file ||
				(typeof File !== 'undefined' &&
					file instanceof File &&
					file.size <= MAX_UPLOAD_SIZE),
			'File size must be less than 3MB',
		),
	altText: z.string().optional(),
})

const MediaFieldsetSchema = z.object({
	id: z.string().optional(),
	mediaId: z.string().optional(),
	fileId: z.string().optional(),
	type: z.enum(['image', 'video']).optional(),
	file: z
		.any()
		.optional()
		.refine(
			(file) =>
				!file ||
				(typeof File !== 'undefined' &&
					file instanceof File &&
					file.size <=
						(file.type?.startsWith('video/')
							? MAX_UPLOAD_SIZE * 10
							: MAX_UPLOAD_SIZE)), // 30MB for videos, 3MB for images
			'File size must be less than 30MB for videos or 3MB for images',
		),
	altText: z.string().optional(),
})

export type ImageFieldset = z.infer<typeof ImageFieldsetSchema>
export type MediaFieldset = z.infer<typeof MediaFieldsetSchema>

export const OrgNoteEditorSchema = z.object({
	actionType: z.string().optional(),
	id: z.string().optional(),
	title: z.string().min(titleMinLength).max(titleMaxLength),
	content: z.string().min(contentMinLength).max(contentMaxLength),
	priority: z.string().optional(),
	tags: z.string().optional(), // JSON string of tags array
	images: z.array(ImageFieldsetSchema).max(5).optional(),
	media: z.array(MediaFieldsetSchema).max(5).optional(),
})

type OrgNoteEditorProps = {
	note?: {
		id: string
		title: string
		content: string
		priority?: string | null
		tags?: string | null
		uploads: Array<{
			id: string
			type: string
			altText: string | null
			objectKey: string
		}>
	}
	actionData?: {
		result: any
	}
	onSuccess?: () => void
	organizationId: string
	mediaTransformBaseUrl?: string | null
}

export function OrgNoteEditor({
	note,
	actionData,
	onSuccess,
	organizationId,
	mediaTransformBaseUrl = null,
}: OrgNoteEditorProps) {
	const { _ } = useLingui()
	const isPending = useIsPending()
	const params = useParams<{ orgSlug: string }>()
	const fetcher = useFetcher()
	const [titleValue, setTitleValue] = useState(note?.title || '')
	const [contentValue, setContentValue] = useState(note?.content || '')
	const contentEditorRef = useRef<ContentEditorRef>(null)

	// Track submission state to trigger onSuccess
	useEffect(() => {
		if (fetcher.state === 'submitting' && onSuccess) {
			onSuccess()
		}
	}, [fetcher.state, onSuccess, fetcher])

	const [form, fields] = useForm({
		id: 'org-note-editor',
		constraint: getZodConstraint(OrgNoteEditorSchema),
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: OrgNoteEditorSchema })
		},
		defaultValue: {
			...note,
			content: note?.content || '',
			priority: note?.priority || '',
			tags: (() => {
				try {
					if (typeof note?.tags === 'string') {
						const tags = JSON.parse(note.tags)
						if (Array.isArray(tags)) {
							return tags.join(', ')
						}
					}
					return ''
				} catch {
					return ''
				}
			})(),
			images: note?.uploads?.filter((u) => u.type === 'image') ?? [],
			media: note?.uploads ?? [],
		},
		shouldRevalidate: 'onBlur',
	})

	const handleContentGenerated = (generatedContent: string) => {
		// Update the TipTap editor with the generated content
		if (contentEditorRef.current) {
			contentEditorRef.current.setContent(generatedContent)
			setContentValue(generatedContent)
		}
	}

	return (
		<>
			<FormProvider context={form.context}>
				<div className="flex-1 overflow-y-auto px-6 pt-4 pb-8">
					<fetcher.Form
						method="POST"
						action={
							note
								? `/${params.orgSlug}/notes/${note.id}/edit`
								: `/${params.orgSlug}/notes/new`
						}
						className="flex flex-col gap-y-4"
						{...getFormProps(form)}
						encType="multipart/form-data"
					>
						{/*
						This hidden submit button is here to ensure that when the user hits
						"enter" on an input field, the primary form function is submitted
						rather than the first button in the form (which is delete/add image).
					*/}
						<button type="submit" className="hidden" />
						{note ? <input type="hidden" name="id" value={note.id} /> : null}
						<div className="flex flex-col gap-1">
							<Field
								data-invalid={fields.title.errors?.length ? true : undefined}
							>
								<FieldLabel htmlFor={fields.title.id}>Title</FieldLabel>
								<Input
									autoFocus
									{...getInputProps(fields.title, { type: 'text' })}
									onChange={(e) => setTitleValue(e.target.value)}
									aria-invalid={fields.title.errors?.length ? true : undefined}
								/>
								<FieldError
									errors={convertErrorsToFieldFormat(fields.title.errors)}
								/>
							</Field>

							{/* Priority and Tags Row */}
							<div className="flex gap-4">
								<div className="flex-1">
									<label
										htmlFor={fields.priority.id}
										className="text-sm leading-none font-medium"
									>
										Priority
									</label>
									<select
										id={fields.priority.id}
										name={fields.priority.name}
										defaultValue={fields.priority.initialValue}
										className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
									>
										<option value="">Select priority</option>
										<option value="no-priority">No priority</option>
										<option value="urgent">Urgent</option>
										<option value="high">High</option>
										<option value="medium">Medium</option>
										<option value="low">Low</option>
									</select>
									{fields.priority.errors && (
										<div className="min-h-[32px] px-4 pt-1 pb-3">
											<ErrorList
												id={fields.priority.errorId}
												errors={fields.priority.errors}
											/>
										</div>
									)}
								</div>

								<div className="flex-1">
									<Field
										data-invalid={fields.tags.errors?.length ? true : undefined}
									>
										<FieldLabel htmlFor={fields.tags.id}>
											Tags (comma-separated)
										</FieldLabel>
										<Input
											{...getInputProps(fields.tags, { type: 'text' })}
											placeholder={_(t`e.g. urgent, meeting, project`)}
											aria-invalid={
												fields.tags.errors?.length ? true : undefined
											}
										/>
										<FieldError
											errors={convertErrorsToFieldFormat(fields.tags.errors)}
										/>
									</Field>
								</div>
							</div>
							<div className="flex flex-col gap-2">
								<div className="flex items-center justify-between">
									<label className="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
										Content
									</label>
									<AIContentGenerator
										title={titleValue}
										onContentGenerated={handleContentGenerated}
										disabled={isPending}
									/>
								</div>
								<ContentEditor
									ref={contentEditorRef}
									value={contentValue}
									onChange={setContentValue}
									name={fields.content.name}
									disabled={isPending}
									placeholder={_(t`Write your note content...`)}
								/>
								{fields.content.errors && (
									<div className="min-h-[32px] px-4 pt-1 pb-3">
										<ErrorList
											id={fields.content.errorId}
											errors={fields.content.errors}
										/>
									</div>
								)}
							</div>
							<LazyLoadErrorBoundary
								fallback={
									<div className="border-destructive/50 bg-destructive/10 rounded-md border p-4 text-center">
										<div className="text-destructive text-sm">
											Failed to load media upload component
										</div>
									</div>
								}
							>
								<Suspense
									fallback={<div className="bg-muted h-20 animate-pulse" />}
								>
									<MultiMediaUpload
										meta={fields.media}
										formId={form.id}
										existingImages={note?.uploads?.filter(
											(u) => u.type === 'image',
										)}
										existingVideos={note?.uploads?.filter(
											(u) => u.type === 'video',
										)}
										organizationId={organizationId}
										mediaTransformBaseUrl={mediaTransformBaseUrl}
									/>
								</Suspense>
							</LazyLoadErrorBoundary>
						</div>
						<ErrorList id={form.errorId} errors={form.errors} />
					</fetcher.Form>
				</div>

				<div className="bg-background shrink-0 border-t px-6 py-4">
					<div className="flex items-center justify-end gap-2 md:gap-3">
						<Button
							variant="outline"
							size="sm"
							{...form.reset.getButtonProps()}
						>
							Reset
						</Button>
						<StatusButton
							form={form.id}
							type="submit"
							disabled={isPending}
							status={isPending ? 'pending' : 'idle'}
							size="sm"
						>
							{note ? 'Update' : 'Create'}
						</StatusButton>
					</div>
				</div>
			</FormProvider>
		</>
	)
}

export function ErrorBoundary() {
	return (
		<GeneralErrorBoundary
			statusHandlers={{
				404: ({ params }) => {
					const noteId = params.noteId
					return (
						<p>
							<Trans>No note with the id "{noteId}" exists</Trans>
						</p>
					)
				},
			}}
		/>
	)
}
