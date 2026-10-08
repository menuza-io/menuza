import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	compileTrainingRules,
	MAX_TRAINING_RULES,
	TRAINING_RULE_LIMIT_ERROR,
	TRAINING_RULE_PRIORITIES,
	type TrainingRuleCategory,
	trainingRuleCategoriesFor,
	type TrainingRuleInput,
	type TrainingRulePriority,
} from '@repo/phone-agent'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useMemo, useState } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { useVerticalLabels } from '#app/components/phone-agent/vertical-labels.ts'
import { phoneAgentVerticalUi } from '#app/components/phone-agent/vertical-ui.tsx'
import { phoneAgentVertical } from '#app/utils/phone-agent/vertical.ts'
import { type Route } from './+types/training.ts'
import { type TrainingActionResult } from './training.server.ts'

export { action, loader } from './training.server.ts'

const DESCRIPTION_MAX = 1000
const ALL_SCOPES = '__all__'

const RULE_CATEGORIES = trainingRuleCategoriesFor(phoneAgentVertical)

type LoaderData = Route.ComponentProps['loaderData']
type Rule = LoaderData['rules'][number]
type Scope = LoaderData['scopes'][number]
type RuleDraft = TrainingRuleInput & { id?: string }

const PRIORITY_LABELS: Record<TrainingRulePriority, MessageDescriptor> = {
	high: msg`High`,
	medium: msg`Medium`,
	low: msg`Low`,
}

const EXAMPLES = phoneAgentVerticalUi.ruleExamples ?? []

function emptyDraft(
	category: TrainingRuleCategory = RULE_CATEGORIES[0]?.id ?? 'escalation',
): RuleDraft {
	return {
		category,
		title: '',
		description: '',
		priority: 'medium',
		isActive: true,
		scopeId: null,
	}
}

export default function PhoneAgentTraining() {
	const { rules, scopes, canUpdate, verticalSettings } =
		useLoaderData<LoaderData>()
	const { _ } = useLingui()
	const labels = useVerticalLabels()
	const [editing, setEditing] = useState<RuleDraft | null>(null)
	const [deleting, setDeleting] = useState<Rule | null>(null)
	const scopeName = new Map(scopes.map((scope) => [scope.id, scope.name]))

	// Scoped rules only load on calls for that scope, so the heaviest context
	// is whichever scope has the most rules in play.
	const droppedCount = useMemo(() => {
		const contexts = [null, ...scopes.map((scope) => scope.id)]
		const include = phoneAgentVerticalUi.includeRule
		return Math.max(
			0,
			...contexts.map(
				(scopeId) =>
					compileTrainingRules(rules, {
						scopeId,
						categories: RULE_CATEGORIES,
						include: include
							? (rule) => include(rule, verticalSettings)
							: undefined,
					}).droppedIds.length,
			),
		)
	}, [rules, scopes, verticalSettings])

	const atLimit = rules.length >= MAX_TRAINING_RULES
	const addButton = canUpdate ? (
		<Button
			type="button"
			disabled={atLimit}
			onClick={() => setEditing(emptyDraft())}
		>
			<Icon name="plus" />
			<Trans>Add rule</Trans>
		</Button>
	) : null

	return (
		<div className="flex flex-col gap-8">
			<PageHeader
				title={<Trans>Training rules</Trans>}
				description={
					<Trans>
						Rules teach the agent how your business works. High priority rules
						are included first; when there are too many, the rest are left out.
					</Trans>
				}
				actions={addButton}
			/>

			{droppedCount > 0 ? (
				<div
					role="status"
					className="flex items-start gap-3 rounded-lg border p-4 text-sm"
				>
					<Icon name="alert-triangle" className="text-destructive mt-0.5" />
					<p>
						{_(
							plural(droppedCount, {
								one: '# rule is being left out because the prompt is full. Shorten rules or turn some off. High priority rules are kept first.',
								other:
									'# rules are being left out because the prompt is full. Shorten rules or turn some off. High priority rules are kept first.',
							}),
						)}
					</p>
				</div>
			) : null}

			{canUpdate && atLimit ? (
				<p role="status" className="text-muted-foreground text-sm">
					<Trans>
						You have {MAX_TRAINING_RULES} rules, the most allowed. Delete one to
						add another.
					</Trans>
				</p>
			) : null}

			{rules.length === 0 ? (
				<div className="rounded-lg border border-dashed py-4">
					<Empty>
						<EmptyHeader>
							<EmptyTitle>
								<Trans>No training rules yet</Trans>
							</EmptyTitle>
							<EmptyDescription>
								<Trans>
									Start with an example and change it to match your business.
								</Trans>
							</EmptyDescription>
						</EmptyHeader>
						{canUpdate && EXAMPLES.length ? (
							<EmptyContent>
								<div className="flex flex-wrap justify-center gap-2">
									{EXAMPLES.map((example) => (
										<Button
											key={example.category + example.title.id}
											type="button"
											variant="outline"
											size="sm"
											onClick={() =>
												setEditing({
													...emptyDraft(example.category),
													title: _(example.title),
													description: _(example.description),
												})
											}
										>
											{_(example.title)}
										</Button>
									))}
								</div>
							</EmptyContent>
						) : null}
					</Empty>
				</div>
			) : (
				<AnnotatedLayout>
					{labels.ruleCategories.map(({ id: category, label, description }) => {
						const inCategory = rules.filter(
							(rule) => rule.category === category,
						)
						const categoryLabel = label
						const notice = phoneAgentVerticalUi.ruleCategoryNotice?.(
							category,
							verticalSettings,
						)
						const addToCategory = canUpdate ? (
							<Button
								type="button"
								variant={inCategory.length === 0 ? 'outline' : 'ghost'}
								size="sm"
								disabled={atLimit}
								aria-label={_(msg`Add a ${categoryLabel} rule`)}
								onClick={() => setEditing(emptyDraft(category))}
							>
								<Icon name="plus" />
								<Trans>Add rule</Trans>
							</Button>
						) : null
						return (
							<AnnotatedSection
								key={category}
								title={categoryLabel}
								description={description ?? undefined}
							>
								<Card>
									<CardContent className="flex flex-col gap-3">
										{notice ? (
											<p className="text-muted-foreground flex items-center gap-2 text-xs">
												<Icon name="info" />
												{_(notice)}
											</p>
										) : null}
										{inCategory.length === 0 ? (
											<div className="flex flex-wrap items-center justify-between gap-3">
												<p className="text-muted-foreground text-sm">
													<Trans>No rules yet.</Trans>
												</p>
												{addToCategory}
											</div>
										) : (
											<>
												<ul className="divide-y">
													{inCategory.map((rule) => (
														<RuleRow
															key={rule.id}
															rule={rule}
															scopeLabel={
																labels.scope
																	? rule.scopeId
																		? (scopeName.get(rule.scopeId) ??
																			labels.scope.unknown)
																		: labels.scope.all
																	: null
															}
															canUpdate={canUpdate}
															onEdit={() =>
																setEditing({
																	id: rule.id,
																	category: rule.category,
																	title: rule.title,
																	description: rule.description,
																	priority: rule.priority,
																	isActive: rule.isActive,
																	scopeId: rule.scopeId ?? null,
																})
															}
															onDelete={() => setDeleting(rule)}
														/>
													))}
												</ul>
												{addToCategory ? (
													<div className="-ms-2">{addToCategory}</div>
												) : null}
											</>
										)}
									</CardContent>
								</Card>
							</AnnotatedSection>
						)
					})}
				</AnnotatedLayout>
			)}

			{editing ? (
				<RuleDialog
					key={editing.id ?? 'new'}
					draft={editing}
					scopes={scopes}
					onClose={() => setEditing(null)}
				/>
			) : null}
			{deleting ? (
				<DeleteRuleDialog rule={deleting} onClose={() => setDeleting(null)} />
			) : null}
		</div>
	)
}

function RuleRow({
	rule,
	scopeLabel,
	canUpdate,
	onEdit,
	onDelete,
}: {
	rule: Rule
	scopeLabel: string | null
	canUpdate: boolean
	onEdit(): void
	onDelete(): void
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<TrainingActionResult>()
	const pendingActive =
		fetcher.json &&
		typeof fetcher.json === 'object' &&
		'isActive' in fetcher.json
			? Boolean(fetcher.json.isActive)
			: null
	const isActive = pendingActive ?? rule.isActive
	const ruleTitle = rule.title

	return (
		<li className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium">{rule.title}</span>
					<Badge variant={rule.priority === 'high' ? 'default' : 'secondary'}>
						{_(PRIORITY_LABELS[rule.priority])}
					</Badge>
					{scopeLabel ? <Badge variant="outline">{scopeLabel}</Badge> : null}
				</div>
				<p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
					{rule.description}
				</p>
				{fetcher.data && !fetcher.data.ok && fetcher.data.error ? (
					<p role="alert" className="text-destructive mt-1 text-xs">
						{fetcher.data.error}
					</p>
				) : null}
			</div>
			<div className="flex items-center gap-2">
				<Switch
					checked={isActive}
					disabled={!canUpdate}
					aria-label={_(msg`Use "${ruleTitle}"`)}
					onCheckedChange={(checked) =>
						void fetcher.submit(
							{ intent: 'toggle', id: rule.id, isActive: checked },
							{ method: 'POST', encType: 'application/json' },
						)
					}
				/>
				{canUpdate ? (
					<>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={_(msg`Edit "${ruleTitle}"`)}
							onClick={onEdit}
						>
							<Icon name="pencil" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={_(msg`Delete "${ruleTitle}"`)}
							onClick={onDelete}
						>
							<Icon name="trash-2" />
						</Button>
					</>
				) : null}
			</div>
		</li>
	)
}

function RuleDialog({
	draft,
	scopes,
	onClose,
}: {
	draft: RuleDraft
	scopes: Scope[]
	onClose(): void
}) {
	const { _ } = useLingui()
	const labels = useVerticalLabels()
	const categoryItems = labels.ruleCategories.map(({ id, label }) => ({
		value: id,
		label,
	}))
	if (!categoryItems.some((item) => item.value === draft.category)) {
		categoryItems.push({
			value: draft.category,
			label: labels.ruleCategoryLabel(draft.category),
		})
	}
	const fetcher = useFetcher<TrainingActionResult>()
	const [category, setCategory] = useState(draft.category)
	const [title, setTitle] = useState(draft.title)
	const [description, setDescription] = useState(draft.description)
	const [priority, setPriority] = useState(draft.priority)
	const [scopeId, setScopeId] = useState(draft.scopeId ?? ALL_SCOPES)
	const [isActive, setIsActive] = useState(draft.isActive)
	const pending = fetcher.state !== 'idle'
	const result = fetcher.data
	const fieldErrors = result && !result.ok ? result.fieldErrors : undefined

	useEffect(() => {
		if (fetcher.state === 'idle' && result?.ok) onClose()
	}, [fetcher.state, result, onClose])

	const scopeItems = labels.scope
		? [
				{ value: ALL_SCOPES, label: labels.scope.all },
				...scopes.map((scope) => ({ value: scope.id, label: scope.name })),
			]
		: []
	const descriptionLength = description.length

	return (
		<Dialog
			defaultOpen
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<DialogContent className="max-h-dvh overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{draft.id ? <Trans>Edit rule</Trans> : <Trans>Add rule</Trans>}
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Write it the way you'd explain it to a new staff member.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault()
						void fetcher.submit(
							{
								intent: 'save',
								...(draft.id ? { id: draft.id } : {}),
								category,
								title,
								description,
								priority,
								isActive,
								scopeId: scopeId === ALL_SCOPES ? null : scopeId,
							},
							{ method: 'POST', encType: 'application/json' },
						)
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="rule-category">
							<Trans>Category</Trans>
						</Label>
						<Select
							value={category}
							items={categoryItems}
							onValueChange={(value) => {
								const next = categoryItems.find((item) => item.value === value)
								if (next) setCategory(next.value)
							}}
						>
							<SelectTrigger id="rule-category" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{categoryItems.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="rule-title">
							<Trans>Title</Trans>
						</Label>
						<Input
							id="rule-title"
							value={title}
							maxLength={120}
							required
							autoFocus
							aria-invalid={fieldErrors?.title ? true : undefined}
							onChange={(event) => setTitle(event.target.value)}
						/>
						{fieldErrors?.title ? (
							<p role="alert" className="text-destructive text-xs">
								{fieldErrors.title}
							</p>
						) : null}
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="rule-description">
							<Trans>What the agent should do</Trans>
						</Label>
						<Textarea
							id="rule-description"
							value={description}
							rows={4}
							maxLength={DESCRIPTION_MAX}
							required
							aria-invalid={fieldErrors?.description ? true : undefined}
							aria-describedby="rule-description-count"
							onChange={(event) => setDescription(event.target.value)}
						/>
						<p
							id="rule-description-count"
							className="text-muted-foreground text-xs tabular-nums"
						>
							{descriptionLength}/{DESCRIPTION_MAX}
						</p>
						{fieldErrors?.description ? (
							<p role="alert" className="text-destructive text-xs">
								{fieldErrors.description}
							</p>
						) : null}
					</div>

					<div className="grid gap-4 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="rule-priority">
								<Trans>Priority</Trans>
							</Label>
							<Select
								value={priority}
								items={TRAINING_RULE_PRIORITIES.map((value) => ({
									value,
									label: _(PRIORITY_LABELS[value]),
								}))}
								onValueChange={(value) => {
									const next = TRAINING_RULE_PRIORITIES.find(
										(item) => item === value,
									)
									if (next) setPriority(next)
								}}
							>
								<SelectTrigger id="rule-priority" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TRAINING_RULE_PRIORITIES.map((value) => (
										<SelectItem key={value} value={value}>
											{_(PRIORITY_LABELS[value])}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						{labels.scope ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="rule-scope">{labels.scope.label}</Label>
								<Select
									value={scopeId}
									items={scopeItems}
									onValueChange={(value) => {
										if (typeof value === 'string') setScopeId(value)
									}}
								>
									<SelectTrigger id="rule-scope" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{scopeItems.map((item) => (
											<SelectItem key={item.value} value={item.value}>
												{item.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						) : null}
					</div>

					<div className="flex items-center justify-between gap-4">
						<Label htmlFor="rule-active">
							<Trans>Use this rule on calls</Trans>
						</Label>
						<Switch
							id="rule-active"
							checked={isActive}
							onCheckedChange={(checked) => setIsActive(checked)}
						/>
					</div>

					{result && !result.ok && result.error ? (
						<p role="alert" className="text-destructive text-sm">
							{result.error === TRAINING_RULE_LIMIT_ERROR
								? _(
										msg`You already have ${MAX_TRAINING_RULES} rules, the most allowed. Delete one to add another.`,
									)
								: result.error}
						</p>
					) : null}

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={pending || !title.trim() || !description.trim()}
						>
							{draft.id ? <Trans>Save changes</Trans> : <Trans>Add rule</Trans>}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

function DeleteRuleDialog({ rule, onClose }: { rule: Rule; onClose(): void }) {
	const fetcher = useFetcher<TrainingActionResult>()
	const pending = fetcher.state !== 'idle'
	const result = fetcher.data
	const ruleTitle = rule.title

	useEffect(() => {
		if (fetcher.state === 'idle' && result?.ok) onClose()
	}, [fetcher.state, result, onClose])

	return (
		<Dialog
			defaultOpen
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Delete "{ruleTitle}"?</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							The agent stops following this rule. To pause it instead, turn it
							off.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{result && !result.ok && result.error ? (
					<p role="alert" className="text-destructive text-sm">
						{result.error}
					</p>
				) : null}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={pending}
						onClick={() =>
							void fetcher.submit(
								{ intent: 'delete', id: rule.id },
								{ method: 'POST', encType: 'application/json' },
							)
						}
					>
						<Trans>Delete rule</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
