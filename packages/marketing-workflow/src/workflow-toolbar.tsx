import { msg, Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useState, type FormEvent, type ReactNode } from 'react'
import { type JourneyStatus } from './types.ts'
import { type RealtimeValidationState } from './validation.ts'
import { useWorkflowUiLabels } from './workflow-labels.ts'

interface WorkflowToolbarProps {
	name: string
	onNameChange: (name: string) => void
	status: JourneyStatus
	validation: RealtimeValidationState
	isSaving?: boolean
	isPublishing?: boolean
	onSave: () => void
	onPublish: () => void
	onPause?: () => void
	onTestRun: (customerId: string) => void
	onBack: () => void
	onViewRuns?: () => void
	onFitView?: () => void
	/** Extra controls rendered in the action cluster (e.g. the app's AI toggle). */
	headerExtras?: ReactNode
	className?: string
}

export function WorkflowToolbar({
	name,
	onNameChange,
	status,
	validation,
	isSaving,
	isPublishing,
	onSave,
	onPublish,
	onPause,
	onTestRun,
	onBack,
	onViewRuns,
	onFitView,
	headerExtras,
	className,
}: WorkflowToolbarProps) {
	const { _ } = useLingui()
	const { journeyStatusLabel } = useWorkflowUiLabels()
	const [showValidationDialog, setShowValidationDialog] = useState(false)
	const [showTestRunDialog, setShowTestRunDialog] = useState(false)
	const [testCustomerId, setTestCustomerId] = useState('cust_test_123')
	const [editingTitle, setEditingTitle] = useState(false)
	const [titleValue, setTitleValue] = useState(name)

	const isValid = validation.valid
	const errorCount = validation.errors.length

	const handleTestRunSubmit = (e: FormEvent) => {
		e.preventDefault()
		if (testCustomerId.trim()) {
			onTestRun(testCustomerId.trim())
			setShowTestRunDialog(false)
		}
	}

	const handleSaveTitle = () => {
		onNameChange(titleValue)
		setEditingTitle(false)
	}

	return (
		<>
			<header
				className={cn(
					'border-border bg-background z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3',
					className,
				)}
			>
				<div className="flex min-w-0 items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						onClick={onBack}
						aria-label={_(msg`Back to automations`)}
					>
						<Icon name="arrow-left" className="size-4" />
					</Button>

					<div className="bg-border hidden h-5 w-px sm:block" aria-hidden />

					{editingTitle ? (
						<Input
							value={titleValue}
							onChange={(e) => setTitleValue(e.target.value)}
							onBlur={handleSaveTitle}
							onKeyDown={(e) => {
								if (e.key === 'Enter') handleSaveTitle()
								if (e.key === 'Escape') {
									setTitleValue(name)
									setEditingTitle(false)
								}
							}}
							className="h-7 max-w-56 text-sm font-medium"
							autoFocus
						/>
					) : (
						<div className="flex items-center gap-1">
							<button
								type="button"
								className="hover:bg-muted focus-visible:ring-ring max-w-52 truncate rounded-md px-1.5 py-1 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
								onClick={() => setEditingTitle(true)}
								title={name}
							>
								{name}
							</button>
							{onViewRuns ? (
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												variant="ghost"
												size="icon-xs"
												className="text-muted-foreground hover:text-foreground"
												aria-label={_(msg`Automation menu`)}
											>
												<Icon name="chevron-down" className="size-3.5" />
											</Button>
										}
									/>
									<DropdownMenuContent align="start" className="w-56">
										<DropdownMenuItem onSelect={onViewRuns}>
											<Icon name="clock" className="mr-2 size-4" />
											<Trans>Run history</Trans>
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onSelect={() => setShowTestRunDialog(true)}
										>
											<Icon name="play" className="mr-2 size-4" />
											<Trans>Test run</Trans>
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							) : null}
						</div>
					)}

					<div className="text-muted-foreground hidden items-center gap-1.5 text-xs sm:flex">
						<span
							className={cn(
								'size-1.5 rounded-full',
								status === 'active'
									? 'bg-emerald-500'
									: status === 'paused'
										? 'bg-amber-500'
										: status === 'archived'
											? 'bg-destructive'
											: 'bg-muted-foreground/40',
							)}
						/>
						<span className="capitalize">{journeyStatusLabel(status)}</span>
					</div>
				</div>

				<div className="flex shrink-0 items-center gap-2">
					{headerExtras}

					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onSave}
						disabled={isSaving}
					>
						{isSaving ? <Trans>Saving...</Trans> : <Trans>Save draft</Trans>}
					</Button>

					{status === 'active' && onPause ? (
						<Button type="button" variant="outline" size="sm" onClick={onPause}>
							<Trans>Pause</Trans>
						</Button>
					) : (
						<Button
							type="button"
							size="sm"
							onClick={onPublish}
							disabled={!isValid || isPublishing}
							title={
								!isValid
									? _(msg`Fix validation errors before publishing`)
									: _(msg`Publish and activate automation`)
							}
						>
							{isPublishing ? (
								<Trans>Publishing...</Trans>
							) : (
								<Trans>Publish</Trans>
							)}
						</Button>
					)}

					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={_(msg`More actions`)}
								>
									<Icon name="ellipsis" className="size-4" />
								</Button>
							}
						/>
						<DropdownMenuContent align="end" className="min-w-44">
							<DropdownMenuItem onClick={() => setShowValidationDialog(true)}>
								<Icon
									name={isValid ? 'check-circle' : 'alert-triangle'}
									className="mr-2 size-4"
								/>
								{isValid ? (
									<Trans>Validation passed</Trans>
								) : (
									<Plural
										value={errorCount}
										one="# validation error"
										other="# validation errors"
									/>
								)}
							</DropdownMenuItem>
							<DropdownMenuItem onClick={onFitView}>
								<Icon name="layout-grid" className="mr-2 size-4" />
								<Trans>Fit canvas view</Trans>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</header>

			<Dialog
				open={showValidationDialog}
				onOpenChange={setShowValidationDialog}
			>
				<DialogContent className="sm:max-w-[480px]">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							{isValid ? (
								<div className="flex size-7 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
									<Icon name="check" className="size-4" />
								</div>
							) : (
								<div className="bg-destructive/10 text-destructive flex size-7 items-center justify-center rounded-full">
									<Icon name="alert-triangle" className="size-4" />
								</div>
							)}
							<span>
								<Trans>Workflow validation</Trans>
							</span>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Structural checks for triggers, connections, and node
								configuration.
							</Trans>
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4 py-2">
						<div className="grid grid-cols-3 gap-2 rounded-lg border p-3 text-center">
							<div>
								<p className="text-muted-foreground text-[11px]">
									<Trans>Nodes</Trans>
								</p>
								<p className="text-base font-semibold tabular-nums">
									{validation.nodeCount}
								</p>
							</div>
							<div>
								<p className="text-muted-foreground text-[11px]">
									<Trans>Connections</Trans>
								</p>
								<p className="text-base font-semibold tabular-nums">
									{validation.edgeCount}
								</p>
							</div>
							<div>
								<p className="text-muted-foreground text-[11px]">
									<Trans>Cycles</Trans>
								</p>
								<p
									className={cn(
										'text-base font-semibold',
										validation.hasCycles
											? 'text-destructive'
											: 'text-emerald-600',
									)}
								>
									{validation.hasCycles ? (
										<Trans>Detected</Trans>
									) : (
										<Trans>None</Trans>
									)}
								</p>
							</div>
						</div>

						{validation.errors.length > 0 ? (
							<div className="space-y-2">
								<h4 className="text-destructive text-xs font-medium">
									<Trans>Errors</Trans> ({validation.errors.length})
								</h4>
								<ul className="border-destructive/20 text-destructive space-y-1.5 rounded-lg border p-3 text-xs">
									{validation.errors.map((err, i) => (
										<li key={i}>{err}</li>
									))}
								</ul>
							</div>
						) : null}

						{validation.warnings.length > 0 ? (
							<div className="space-y-2">
								<h4 className="text-xs font-medium text-amber-600 dark:text-amber-400">
									<Trans>Warnings</Trans> ({validation.warnings.length})
								</h4>
								<ul className="space-y-1.5 rounded-lg border border-amber-500/20 p-3 text-xs text-amber-700 dark:text-amber-300">
									{validation.warnings.map((warn, i) => (
										<li key={i}>{warn}</li>
									))}
								</ul>
							</div>
						) : null}

						{isValid && validation.warnings.length === 0 ? (
							<p className="text-muted-foreground rounded-lg border p-3 text-center text-xs">
								<Trans>
									All checks passed. This workflow is ready to publish.
								</Trans>
							</p>
						) : null}
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setShowValidationDialog(false)}
						>
							<Trans>Close</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={showTestRunDialog} onOpenChange={setShowTestRunDialog}>
				<DialogContent className="sm:max-w-[420px]">
					<form onSubmit={handleTestRunSubmit}>
						<DialogHeader>
							<DialogTitle>
								<Trans>Test run</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>
									Trigger a test execution for a specific customer ID.
								</Trans>
							</DialogDescription>
						</DialogHeader>

						<div className="space-y-4 py-4">
							<div className="space-y-2">
								<Label htmlFor="testCustomerId" className="text-xs font-medium">
									<Trans>Customer ID</Trans>
								</Label>
								<Input
									id="testCustomerId"
									value={testCustomerId}
									onChange={(e) => setTestCustomerId(e.target.value)}
									placeholder={_(msg`e.g. cust_123`)}
									required
								/>
								<p className="text-muted-foreground text-[11px]">
									<Trans>
										Only the customer ID is sent. Regional tenant-api resolves
										PII locally.
									</Trans>
								</p>
							</div>
						</div>

						<DialogFooter className="gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setShowTestRunDialog(false)}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button type="submit" size="sm">
								<Trans>Launch run</Trans>
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	)
}
