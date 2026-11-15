import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	buildEmailTemplateBlocks,
	EMAIL_BLOCK_TEMPLATES,
	type EmailBlock,
} from '@repo/common/email-blocks'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useRef, useState } from 'react'
import { useFetcher } from 'react-router'

import { EmailPreview } from './email-preview.tsx'

/** Saved templates as the designer's resource route returns them. */
export type SavedEmailTemplate = {
	id: string
	name: string
	blocks: EmailBlock[]
	updatedAt: string
}

export type EmailTemplateErrorCode =
	| 'template_limit_reached'
	| 'template_name_taken'
	| 'template_not_found'
	| 'invalid_name'
	| 'invalid_blocks'

/** What the operator reads for a refused save or start. */
export function useEmailTemplateErrors() {
	const { _ } = useLingui()
	return (code: string | undefined): string => {
		switch (code) {
			case 'template_limit_reached':
				return _(
					msg`You can keep up to 100 templates. Delete one to save another.`,
				)
			case 'template_name_taken':
				return _(msg`You already have a template with that name.`)
			case 'template_not_found':
				return _(msg`That template no longer exists.`)
			case 'invalid_name':
				return _(msg`Give the template a name of up to 80 characters.`)
			case 'invalid_blocks':
				return _(msg`There is nothing to save yet. Add a block first.`)
			default:
				return _(msg`Something went wrong. Try again.`)
		}
	}
}

/**
 * A small picture of an email, drawn by the designer's own preview intent. It
 * asks for the render once, on mount, and clips the result.
 */
export function EmailTemplateThumbnail({
	blocks,
	previewEndpoint,
}: {
	blocks: EmailBlock[]
	/** The route action that answers `email_preview` (default: this route). */
	previewEndpoint?: string
}) {
	const fetcher = useFetcher<{ html?: string }>()
	const fetcherRef = useRef(fetcher)
	fetcherRef.current = fetcher
	const blocksJson = JSON.stringify(blocks)

	useEffect(() => {
		fetcherRef.current.submit(
			{ intent: 'email_preview', blocks: blocksJson, subject: '' },
			previewEndpoint
				? { method: 'post', action: previewEndpoint }
				: { method: 'post' },
		)
	}, [blocksJson, previewEndpoint])

	return (
		<div
			aria-hidden
			className="bg-muted pointer-events-none h-44 overflow-hidden rounded-lg"
		>
			<EmailPreview
				html={typeof fetcher.data?.html === 'string' ? fetcher.data.html : ''}
				loading={fetcher.state !== 'idle'}
				framed={false}
			/>
		</div>
	)
}

type Mode = 'pick' | 'save'

/**
 * "Templates" in the designer: start from a built-in starter or one of the
 * restaurant's own saved templates, or save the open design as a template.
 * Starting from a template copies it into the design; saved templates are
 * never linked to the messages made from them.
 */
export function EmailTemplatesDialog({
	open,
	onOpenChange,
	blocks,
	onApply,
	endpoint,
	previewEndpoint,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	blocks: EmailBlock[]
	onApply: (blocks: EmailBlock[]) => void
	/** The designer resource route (`templates/designer`). */
	endpoint: string
	previewEndpoint?: string
}) {
	const { _ } = useLingui()
	const errorText = useEmailTemplateErrors()
	const listFetcher = useFetcher<{ templates: SavedEmailTemplate[] }>()
	const actionFetcher = useFetcher<{
		blocks?: EmailBlock[]
		template?: SavedEmailTemplate
		error?: string
	}>()
	const [mode, setMode] = useState<Mode>('pick')
	const [name, setName] = useState('')
	const handledRef = useRef<unknown>(null)

	useEffect(() => {
		if (!open) return
		setMode('pick')
		setName('')
		listFetcher.load(endpoint)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- load once per open
	}, [open, endpoint])

	// A started template arrives as blocks; a saved one closes the dialog.
	useEffect(() => {
		const result = actionFetcher.data
		if (!result || handledRef.current === result) return
		handledRef.current = result
		if (result.blocks) {
			onApply(result.blocks)
			onOpenChange(false)
		} else if (result.template) {
			onOpenChange(false)
		}
	}, [actionFetcher.data, onApply, onOpenChange])

	const saved = listFetcher.data?.templates ?? []
	const busy = actionFetcher.state !== 'idle'
	const error = actionFetcher.data?.error

	const startSaved = (id: string) =>
		actionFetcher.submit(
			{ intent: 'start', id },
			{ method: 'post', action: endpoint },
		)

	const save = () =>
		actionFetcher.submit(
			{ intent: 'save', name, blocks: JSON.stringify(blocks) },
			{ method: 'post', action: endpoint },
		)

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-4 sm:max-w-3xl">
				{mode === 'save' ? (
					<>
						<DialogHeader>
							<DialogTitle>
								<Trans>Save as template</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>
									Saves this layout for next time. A template keeps the blocks
									only: no audience, coupon or schedule.
								</Trans>
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-2">
							<Label htmlFor="email-template-name">
								<Trans>Template name</Trans>
							</Label>
							<Input
								id="email-template-name"
								value={name}
								maxLength={80}
								onChange={(event) => setName(event.target.value)}
								placeholder={_(msg`Weekly newsletter`)}
							/>
							{error ? (
								<p role="alert" className="text-destructive text-sm">
									{errorText(error)}
								</p>
							) : null}
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setMode('pick')}
								disabled={busy}
							>
								<Trans>Back</Trans>
							</Button>
							<Button
								type="button"
								onClick={save}
								disabled={
									busy || name.trim().length === 0 || blocks.length === 0
								}
							>
								<Trans>Save template</Trans>
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>
								<Trans>Start from a template</Trans>
							</DialogTitle>
							<DialogDescription>
								{blocks.length > 0 ? (
									<Trans>
										This replaces the blocks you have now with a copy of the
										template.
									</Trans>
								) : (
									<Trans>Pick a layout, then customize the blocks.</Trans>
								)}
							</DialogDescription>
						</DialogHeader>
						{error ? (
							<p role="alert" className="text-destructive text-sm">
								{errorText(error)}
							</p>
						) : null}
						<div className="max-h-[60vh] space-y-5 overflow-y-auto pe-1">
							<section className="space-y-2">
								<h3 className="text-sm font-medium">
									<Trans>Your templates</Trans>
								</h3>
								{saved.length === 0 ? (
									<p className="text-muted-foreground text-sm">
										<Trans>
											No saved templates yet. Design an email, then choose Save
											as template.
										</Trans>
									</p>
								) : (
									<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
										{saved.map((template) => (
											<button
												key={template.id}
												type="button"
												disabled={busy}
												onClick={() => startSaved(template.id)}
												className="border-border hover:bg-muted/50 focus-visible:ring-ring space-y-2 rounded-xl border p-2 text-start outline-none focus-visible:ring-2"
											>
												<EmailTemplateThumbnail
													blocks={template.blocks}
													previewEndpoint={previewEndpoint}
												/>
												<span className="block truncate text-sm font-medium">
													{template.name}
												</span>
											</button>
										))}
									</div>
								)}
							</section>
							<section className="space-y-2">
								<h3 className="text-sm font-medium">
									<Trans>Starters</Trans>
								</h3>
								<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
									{EMAIL_BLOCK_TEMPLATES.filter(
										(starter) => starter.blocks.length > 0,
									).map((starter) => (
										<button
											key={starter.id}
											type="button"
											onClick={() => {
												onApply(buildEmailTemplateBlocks(starter.id))
												onOpenChange(false)
											}}
											className="border-border hover:bg-muted/50 focus-visible:ring-ring space-y-2 rounded-xl border p-2 text-start outline-none focus-visible:ring-2"
										>
											<EmailTemplateThumbnail
												blocks={buildEmailTemplateBlocks(starter.id)}
												previewEndpoint={previewEndpoint}
											/>
											<span className="block truncate text-sm font-medium">
												{starter.label}
											</span>
										</button>
									))}
								</div>
							</section>
						</div>
						<DialogFooter className="gap-2 sm:items-center sm:justify-between">
							<Button
								type="button"
								variant="outline"
								disabled={blocks.length === 0}
								onClick={() => {
									setMode('save')
									handledRef.current = actionFetcher.data
								}}
							>
								<Icon name="copy" className="size-4" />
								<Trans>Save this design as a template</Trans>
							</Button>
							<DialogClose render={<Button variant="outline" />}>
								<Trans>Close</Trans>
							</DialogClose>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	)
}
