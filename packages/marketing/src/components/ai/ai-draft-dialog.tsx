import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type EmailBlock } from '@repo/common/email-blocks'
import { Button } from '@repo/ui/button'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import { useFetcher } from 'react-router'
import { useAiDraftConfig } from './ai-draft-config.tsx'
import {
	requestAiDraft,
	type AiDraftErrorCode,
	type AiDraftInput,
	type AiDraftResult,
} from './ai-draft-client.ts'

/** The opt-out footer a text message gets; the draft leaves room for it. */
const SMS_FOOTER_LENGTH = 23

type Tone = AiDraftInput['tone']
type Language = AiDraftInput['language']

/** What a host gets back when the operator uses a draft: it only fills the editor. */
export type AiDraftApply =
	| { channel: 'email'; subject: string; subjects: string[]; blocks: EmailBlock[] }
	| { channel: 'sms'; message: string }

export type AiDraftDialogProps = {
	open: boolean
	onOpenChange: (open: boolean) => void
	channel: 'email' | 'sms'
	/** The editor already holds content: using a draft asks before replacing it. */
	hasContent: boolean
	/**
	 * A goal to start from. A later "occasion card" (#152) opens the dialog with
	 * the occasion's words here; nothing else changes.
	 */
	initialGoal?: string
	onApply: (draft: AiDraftApply) => void
}

type Catalog = {
	items?: Array<{ itemId: string; name: string }>
}

/**
 * "Draft with AI" (#155): the operator picks a goal, dishes, a tone and a
 * language; the model answers with three subject lines and designer blocks, or
 * a text message. The answer is shown first and only fills the editor when the
 * operator chooses to use it; nothing is sent or saved from here. A non-empty
 * editor asks before it is replaced.
 */
export function AiDraftDialog({
	open,
	onOpenChange,
	channel,
	hasContent,
	initialGoal,
	onApply,
}: AiDraftDialogProps) {
	const { _ } = useLingui()
	const config = useAiDraftConfig()
	const catalog = useFetcher<Catalog>()
	const [goal, setGoal] = useState(initialGoal ?? '')
	const [tone, setTone] = useState<Tone>('friendly')
	const [language, setLanguage] = useState<Language>(
		config?.defaultLanguage ?? 'en',
	)
	const [itemIds, setItemIds] = useState<string[]>([])
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<AiDraftErrorCode | null>(null)
	const [draft, setDraft] = useState<AiDraftResult | null>(null)
	const [subject, setSubject] = useState('')
	const [confirmReplace, setConfirmReplace] = useState(false)

	useEffect(() => {
		if (open && initialGoal) setGoal(initialGoal)
	}, [open, initialGoal])

	const menuEndpoint = config?.menuItemsEndpoint
	useEffect(() => {
		if (!open || channel !== 'email') return
		// The page's own action answers the dish intent (like the Menu item
		// block); a host may name another route.
		catalog.submit(
			{ intent: 'menu_items', locationId: '' },
			menuEndpoint ? { method: 'post', action: menuEndpoint } : { method: 'post' },
		)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- load once per open
	}, [open, channel, menuEndpoint])

	if (!config) return null

	const presets: Array<{ key: string; label: string; goal: string }> = [
		{
			key: 'dish',
			label: _(msg`Announce a dish`),
			goal: _(msg`Announce a dish and make guests want to order it`),
		},
		{
			key: 'coupon',
			label: _(msg`Promote a coupon`),
			goal: _(msg`Promote the attached coupon`),
		},
		{
			key: 'winback',
			label: _(msg`Win back guests`),
			goal: _(msg`Win back guests who have not ordered in a while`),
		},
		{
			key: 'event',
			label: _(msg`Event or occasion`),
			goal: _(msg`Announce an event or an occasion`),
		},
	]
	const tones: Array<{ value: Tone; label: string }> = [
		{ value: 'friendly', label: _(msg`Friendly`) },
		{ value: 'formal', label: _(msg`Formal`) },
		{ value: 'playful', label: _(msg`Playful`) },
		{ value: 'urgent', label: _(msg`Urgent`) },
	]
	const dishes = catalog.data?.items ?? []

	const errorText = (code: AiDraftErrorCode) => {
		switch (code) {
			case 'ai_draft_invalid':
				return _(msg`That draft could not be used. Please try again.`)
			case 'ai_draft_limit':
				return _(
					msg`You have reached the limit for AI drafts. Please try again later.`,
				)
			case 'ai_not_configured':
				return _(msg`AI drafts are not set up yet.`)
			case 'not_found':
				return _(msg`AI drafts are not available for this organization.`)
			default:
				return _(msg`We could not write a draft right now. Please try again.`)
		}
	}

	const generate = async () => {
		setBusy(true)
		setError(null)
		setDraft(null)
		const result = await requestAiDraft(config, {
			channel,
			goal: goal.trim(),
			tone,
			language,
			itemIds: channel === 'email' ? itemIds : [],
		})
		setBusy(false)
		if (!result.ok) {
			setError(result.error)
			return
		}
		setDraft(result.value)
		setSubject(
			result.value.channel === 'email' ? (result.value.subjects[0] ?? '') : '',
		)
	}

	const apply = () => {
		if (!draft) return
		onApply(
			draft.channel === 'email'
				? {
						channel: 'email',
						subject,
						subjects: draft.subjects,
						blocks: draft.blocks,
					}
				: { channel: 'sms', message: draft.message },
		)
		setConfirmReplace(false)
		setDraft(null)
		onOpenChange(false)
	}

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>
							<Trans>Draft with AI</Trans>
						</DialogTitle>
						<DialogDescription>
							{channel === 'sms' ? (
								<Trans>
									Describe the text you want. You will review it before it fills
									your message. Nothing is sent.
								</Trans>
							) : (
								<Trans>
									Describe the email you want. You will review it before it
									fills your design. Nothing is sent.
								</Trans>
							)}
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="ai-draft-goal">
								<Trans>What is this message for?</Trans>
							</Label>
							<div className="flex flex-wrap gap-2">
								{presets.map((preset) => (
									<Button
										key={preset.key}
										type="button"
										size="sm"
										variant={goal === preset.goal ? 'default' : 'outline'}
										onClick={() => setGoal(preset.goal)}
									>
										{preset.label}
									</Button>
								))}
							</div>
							<Textarea
								id="ai-draft-goal"
								value={goal}
								onChange={(event) => setGoal(event.target.value.slice(0, 300))}
								placeholder={_(msg`For example: our new lunch menu starts Monday`)}
								rows={2}
							/>
						</div>

						{channel === 'email' && dishes.length > 0 ? (
							<fieldset className="space-y-2">
								<legend className="text-sm font-medium">
									<Trans>Dishes to feature (up to three)</Trans>
								</legend>
								<div className="grid max-h-36 gap-1.5 overflow-y-auto sm:grid-cols-2">
									{dishes.map((dish) => {
										const checked = itemIds.includes(dish.itemId)
										return (
											<label
												key={dish.itemId}
												className="flex items-center gap-2 text-sm"
											>
												<Checkbox
													checked={checked}
													disabled={!checked && itemIds.length >= 3}
													onCheckedChange={(next) =>
														setItemIds((current) =>
															next
																? [...current, dish.itemId]
																: current.filter((id) => id !== dish.itemId),
														)
													}
												/>
												<span className="truncate">{dish.name}</span>
											</label>
										)
									})}
								</div>
							</fieldset>
						) : null}

						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="ai-draft-tone">
									<Trans>Tone</Trans>
								</Label>
								<Select
									value={tone}
									onValueChange={(next) => setTone((next as Tone) ?? 'friendly')}
								>
									<SelectTrigger id="ai-draft-tone">
										<SelectValue>
											{tones.find((option) => option.value === tone)?.label}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{tones.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-2">
								<Label htmlFor="ai-draft-language">
									<Trans>Language</Trans>
								</Label>
								<Select
									value={language}
									onValueChange={(next) =>
										setLanguage(next === 'ar' ? 'ar' : 'en')
									}
								>
									<SelectTrigger id="ai-draft-language">
										<SelectValue>
											{language === 'ar' ? _(msg`Arabic`) : _(msg`English`)}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="en">{_(msg`English`)}</SelectItem>
										<SelectItem value="ar">{_(msg`Arabic`)}</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>

						<Button
							type="button"
							onClick={generate}
							disabled={busy || goal.trim().length === 0}
							className="gap-2"
						>
							<Icon name="sparkles" className="size-4" />
							{busy ? <Trans>Writing…</Trans> : draft ? <Trans>Write again</Trans> : <Trans>Write a draft</Trans>}
						</Button>

						{error ? (
							<p role="alert" className="text-destructive text-sm">
								{errorText(error)}
							</p>
						) : null}

						{draft?.channel === 'email' ? (
							<div className="space-y-3 rounded-lg border p-3">
								<fieldset className="space-y-2">
									<legend className="text-sm font-medium">
										<Trans>Choose a subject</Trans>
									</legend>
									{draft.subjects.map((option) => (
										<label
											key={option}
											className="flex items-center gap-2 text-sm"
										>
											<input
												type="radio"
												name="ai-draft-subject"
												checked={subject === option}
												onChange={() => setSubject(option)}
											/>
											<span>{option}</span>
										</label>
									))}
								</fieldset>
								<ul className="text-muted-foreground space-y-1 text-sm">
									{draft.blocks.map((block) => (
										<li key={block.id} className="truncate">
											{'text' in block.config && block.config.text
												? block.config.text
												: block.type === 'button'
													? block.config.label
													: block.type === 'menu_item'
														? _(msg`Featured dishes`)
														: ''}
										</li>
									))}
								</ul>
							</div>
						) : null}

						{draft?.channel === 'sms' ? (
							<div className="space-y-1 rounded-lg border p-3">
								<p className="text-sm">{draft.message}</p>
								<p className="text-muted-foreground text-xs">
									{draft.message.length + SMS_FOOTER_LENGTH} / 160{' '}
									<Trans>characters with the opt-out footer</Trans>
								</p>
							</div>
						) : null}

						{draft ? (
							<div className="flex justify-end gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => onOpenChange(false)}
								>
									<Trans>Cancel</Trans>
								</Button>
								<Button
									type="button"
									onClick={() => (hasContent ? setConfirmReplace(true) : apply())}
								>
									<Trans>Use this draft</Trans>
								</Button>
							</div>
						) : null}
					</div>
				</DialogContent>
			</Dialog>

			<AlertDialog open={confirmReplace} onOpenChange={setConfirmReplace}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Replace what you have?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								Your message already has content. Using this draft replaces it.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep mine</Trans>
						</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={apply}>
							<Trans>Replace</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}

/** The "Draft with AI" button: renders nothing where drafts are not available. */
export function AiDraftButton({
	onClick,
	className,
}: {
	onClick: () => void
	className?: string
}) {
	const config = useAiDraftConfig()
	if (!config) return null
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={onClick}
			className={className ?? 'gap-1.5'}
		>
			<Icon name="sparkles" className="size-3.5" />
			<Trans>Draft with AI</Trans>
		</Button>
	)
}
