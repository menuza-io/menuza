import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Spinner } from '@repo/ui/spinner'
import { useCallback, useEffect, useState } from 'react'
import { useFetcher, useNavigate, useParams } from 'react-router'
import {
	PAGE_TEMPLATES,
	type PageTemplate,
} from '#app/utils/website/block-types.ts'

export function CreatePageDialog({
	open,
	onOpenChange,
	trigger,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	trigger?: React.ReactNode
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher()
	const navigate = useNavigate()
	const params = useParams()
	const [step, setStep] = useState<1 | 2>(1)
	const [template, setTemplate] = useState<PageTemplate>('blank')
	const [title, setTitle] = useState('')
	const [slug, setSlug] = useState('')
	const [slugManuallyEdited, setSlugManuallyEdited] = useState(false)

	// Auto-derive slug from title
	useEffect(() => {
		if (!slugManuallyEdited && title) {
			setSlug(
				title
					.toLowerCase()
					.replace(/[^a-z0-9\s-]/g, '')
					.replace(/\s+/g, '-')
					.replace(/-+/g, '-')
					.replace(/^-|-$/g, ''),
			)
		}
	}, [title, slugManuallyEdited])

	// Navigate to the builder on success
	useEffect(() => {
		const data = fetcher.data as any
		if (data && data.status === 'success' && data.pageId) {
			onOpenChange(false)
			void navigate(`/${params.orgSlug}/website/pages/${data.pageId}`)
		}
	}, [fetcher.data, navigate, params.orgSlug, onOpenChange])

	const handleOpenChange = useCallback(
		(isOpen: boolean) => {
			onOpenChange(isOpen)
			if (!isOpen) {
				setStep(1)
				setTemplate('blank')
				setTitle('')
				setSlug('')
				setSlugManuallyEdited(false)
			}
		},
		[onOpenChange],
	)

	const slugError = (fetcher.data as any)?.result?.error?.slug?.[0]

	const templates = Object.entries(PAGE_TEMPLATES).map(([key, val]) => ({
		value: key as PageTemplate,
		label: val.label,
		description: val.description,
	}))

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			{trigger ? (
				<DialogTrigger render={trigger as React.ReactElement} />
			) : null}
			<DialogContent className="sm:max-w-md">
				{step === 1 ? (
					<>
						<DialogHeader>
							<DialogTitle>
								<Trans>Choose a template</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>Select a starting layout for your new page.</Trans>
							</DialogDescription>
						</DialogHeader>

						<RadioGroup
							value={template}
							onValueChange={(val: string) => setTemplate(val as PageTemplate)}
							className="grid gap-3"
						>
							{templates.map((tmpl) => (
								<ChoiceCard key={tmpl.value}>
									<RadioGroupItem value={tmpl.value} />
									<ChoiceCardContent>
										<ChoiceCardTitle>{tmpl.label}</ChoiceCardTitle>
										<ChoiceCardDescription>
											{tmpl.description}
										</ChoiceCardDescription>
									</ChoiceCardContent>
								</ChoiceCard>
							))}
						</RadioGroup>

						<DialogFooter>
							<Button onClick={() => setStep(2)}>
								<Trans>Next</Trans>
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>
								<Trans>New page</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>Set the title and URL for your new page.</Trans>
							</DialogDescription>
						</DialogHeader>

						<fetcher.Form
							method="POST"
							action={`/${params.orgSlug}/website/pages`}
							className="space-y-4"
						>
							<input type="hidden" name="intent" value="create-page" />
							<input type="hidden" name="template" value={template} />

							<div className="space-y-2">
								<Label htmlFor="page-title">
									<Trans>Page Title</Trans>
								</Label>
								<Input
									id="page-title"
									name="title"
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									placeholder={_(t`e.g. About Us`)}
									required
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="page-slug">
									<Trans>Page URL</Trans>
								</Label>
								<Input
									id="page-slug"
									name="slug"
									value={slug}
									onChange={(e) => {
										setSlug(e.target.value)
										setSlugManuallyEdited(true)
									}}
									placeholder={_(t`e.g. about-us`)}
									required
								/>
								{slugError && (
									<p className="text-destructive text-xs">{slugError}</p>
								)}
								<p className="text-muted-foreground text-xs">
									<Trans>This will be the URL path for this page.</Trans>
								</p>
							</div>

							<DialogFooter>
								<Button
									variant="outline"
									type="button"
									onClick={() => setStep(1)}
								>
									<Trans>Back</Trans>
								</Button>
								<Button
									type="submit"
									disabled={fetcher.state !== 'idle' || !title || !slug}
								>
									{fetcher.state !== 'idle' ? (
										<Spinner />
									) : (
										<Trans>Create</Trans>
									)}
								</Button>
							</DialogFooter>
						</fetcher.Form>
					</>
				)}
			</DialogContent>
		</Dialog>
	)
}
