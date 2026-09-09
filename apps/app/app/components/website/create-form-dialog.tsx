import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { useCallback, useState } from 'react'
import { useFetcher } from 'react-router'

type FieldType = 'text' | 'email' | 'tel' | 'textarea'
type FormField = {
	id: string
	label: string
	type: FieldType
	required: boolean
}

const templateFields: Record<string, FormField[]> = {
	blank: [{ id: 'name', label: 'Name', type: 'text', required: true }],
	contact: [
		{ id: 'name', label: 'Name', type: 'text', required: true },
		{ id: 'email', label: 'Email', type: 'email', required: true },
		{ id: 'message', label: 'Message', type: 'textarea', required: true },
	],
	lead: [
		{ id: 'name', label: 'Name', type: 'text', required: true },
		{ id: 'email', label: 'Email', type: 'email', required: true },
		{ id: 'phone', label: 'Phone', type: 'tel', required: false },
	],
	feedback: [
		{ id: 'email', label: 'Email', type: 'email', required: false },
		{ id: 'feedback', label: 'Feedback', type: 'textarea', required: true },
	],
}

function fieldId(label: string, index: number) {
	return (
		label
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '') || `field-${index + 1}`
	)
}

export function CreateFormDialog({
	open,
	onOpenChange,
	disabled,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	disabled?: boolean
}) {
	const fetcher = useFetcher<{ success?: string; error?: string }>()
	const [template, setTemplate] = useState('blank')
	const [fields, setFields] = useState<FormField[]>(templateFields.blank!)

	const closeAfterSuccess = useCallback(
		(node: HTMLSpanElement | null) => {
			if (node) onOpenChange(false)
		},
		[onOpenChange],
	)

	const chooseTemplate = (value: string) => {
		setTemplate(value)
		setFields(templateFields[value]!.map((field) => ({ ...field })))
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				{fetcher.data?.success ? (
					<span ref={closeAfterSuccess} hidden aria-hidden="true" />
				) : null}
				<fetcher.Form method="post" className="space-y-6">
					<input type="hidden" name="intent" value="create" />
					<input type="hidden" name="fields" value={JSON.stringify(fields)} />
					<DialogHeader>
						<DialogTitle>
							<Trans>Create form</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>Start from a template or build your own field set.</Trans>
						</DialogDescription>
					</DialogHeader>

					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="form-name">
								<Trans>Name</Trans>
							</Label>
							<Input
								id="form-name"
								name="name"
								placeholder="Contact us"
								required
								maxLength={120}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="form-template">
								<Trans>Starting point</Trans>
							</Label>
							<select
								id="form-template"
								value={template}
								onChange={(event) => chooseTemplate(event.target.value)}
								className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
							>
								<option value="blank">Custom form</option>
								<option value="contact">Contact</option>
								<option value="lead">Lead capture</option>
								<option value="feedback">Feedback</option>
							</select>
						</div>
					</div>
					<div className="space-y-2">
						<Label htmlFor="form-description">
							<Trans>Description</Trans>
						</Label>
						<Input
							id="form-description"
							name="description"
							placeholder="How we'll use the information you share"
							maxLength={500}
						/>
					</div>

					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<div>
								<p className="text-sm font-medium">
									<Trans>Fields</Trans>
								</p>
								<p className="text-muted-foreground text-xs">
									<Trans>Add, name, and order each field.</Trans>
								</p>
							</div>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() =>
									setFields((current) => [
										...current,
										{
											id: `field-${current.length + 1}`,
											label: '',
											type: 'text',
											required: false,
										},
									])
								}
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add field</Trans>
							</Button>
						</div>
						{fields.map((field, index) => (
							<div
								key={`${index}-${field.id}`}
								className="border-border grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_9rem_auto_auto] sm:items-end"
							>
								<div className="space-y-1.5">
									<Label htmlFor={`field-label-${index}`}>
										<Trans>Label</Trans>
									</Label>
									<Input
										id={`field-label-${index}`}
										value={field.label}
										placeholder="Field label"
										onChange={(event) =>
											setFields((current) =>
												current.map((item, itemIndex) => {
													if (itemIndex !== index) return item
													const taken = new Set(
														current
															.filter((_, otherIndex) => otherIndex !== index)
															.map((other) => other.id),
													)
													const baseId = fieldId(event.target.value, index)
													let id = baseId
													let suffix = 2
													while (taken.has(id)) id = `${baseId}-${suffix++}`
													return { ...item, label: event.target.value, id }
												}),
											)
										}
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor={`field-type-${index}`}>
										<Trans>Type</Trans>
									</Label>
									<select
										id={`field-type-${index}`}
										value={field.type}
										onChange={(event) =>
											setFields((current) =>
												current.map((item, itemIndex) =>
													itemIndex === index
														? { ...item, type: event.target.value as FieldType }
														: item,
												),
											)
										}
										className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
									>
										<option value="text">Text</option>
										<option value="email">Email</option>
										<option value="tel">Phone</option>
										<option value="textarea">Long text</option>
									</select>
								</div>
								<div className="flex h-9 items-center gap-2">
									<Switch
										checked={field.required}
										onCheckedChange={(checked) =>
											setFields((current) =>
												current.map((item, itemIndex) =>
													itemIndex === index
														? { ...item, required: checked }
														: item,
												),
											)
										}
										aria-label={`${field.label || 'Field'} required`}
									/>
									<span className="text-sm">
										<Trans>Required</Trans>
									</span>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									disabled={fields.length === 1}
									aria-label="Remove field"
									onClick={() =>
										setFields((current) =>
											current.filter((_, itemIndex) => itemIndex !== index),
										)
									}
								>
									<Icon name="trash-2" className="size-4" />
								</Button>
							</div>
						))}
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="submit-label">
								<Trans>Button label</Trans>
							</Label>
							<Input
								id="submit-label"
								name="submitLabel"
								defaultValue="Submit"
								required
								maxLength={50}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="success-message">
								<Trans>Success message</Trans>
							</Label>
							<Input
								id="success-message"
								name="successMessage"
								defaultValue="Thank you. Your response has been received."
								required
								maxLength={300}
							/>
						</div>
					</div>
					{fetcher.data?.error ? (
						<p className="text-destructive text-sm" role="alert">
							{fetcher.data.error}
						</p>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={
								disabled ||
								fetcher.state !== 'idle' ||
								fields.some((field) => !field.label.trim())
							}
						>
							{fetcher.state === 'idle' ? (
								<Trans>Create form</Trans>
							) : (
								<Trans>Creating…</Trans>
							)}
						</Button>
					</DialogFooter>
				</fetcher.Form>
			</DialogContent>
		</Dialog>
	)
}
