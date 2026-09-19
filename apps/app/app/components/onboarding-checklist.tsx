import { Trans, t } from '@lingui/macro'
import {
	type OnboardingProgressData,
	type OnboardingStepWithProgress,
} from '@repo/common/onboarding'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Progress } from '@repo/ui/progress'
import React from 'react'
import { Link, useFetcher } from 'react-router'

interface OnboardingChecklistProps {
	progress: OnboardingProgressData
	orgSlug: string
	organizationId: string
	variant?: 'sidebar' | 'dashboard'
	className?: string
}

function getOnboardingStepHref(
	step: OnboardingStepWithProgress | undefined,
	orgSlug: string,
) {
	if (!step?.actionConfig) {
		return `/${orgSlug}`
	}

	if (step.actionConfig.type === 'navigate') {
		return `/${orgSlug}${step.actionConfig.target}`
	}

	return `/${orgSlug}`
}

export function OnboardingChecklist({
	progress,
	orgSlug,
	organizationId,
	variant = 'dashboard',
	className = '',
}: OnboardingChecklistProps) {
	const fetcher = useFetcher()

	// Don't show if completed and not visible
	if (progress.isCompleted && !progress.isVisible) {
		return null
	}

	const progressPercentage =
		progress.totalSteps > 0
			? (progress.completedCount / progress.totalSteps) * 100
			: 0

	const completedCount = progress.completedCount
	const totalSteps = progress.totalSteps
	const isHiding = fetcher.state !== 'idle'

	const handleStepAction = (step: OnboardingStepWithProgress) => {
		if (!step.actionConfig) return

		switch (step.actionConfig.type) {
			case 'navigate':
				// Navigation will be handled by the Link component
				// Don't auto-complete navigation steps - let auto-detection handle it
				break
			case 'modal':
				// Handle modal opening
				if (step.actionConfig.target === 'command-menu') {
					// Trigger command menu and mark as completed since it's hard to auto-detect
					const event = new KeyboardEvent('keydown', {
						key: 'k',
						metaKey: true,
						ctrlKey: true,
					})
					document.dispatchEvent(event)
				}
				break
			case 'external':
				window.open(step.actionConfig.target, '_blank')
				break
		}
	}

	const handleHide = () => {
		void fetcher.submit(
			{ organizationId },
			{ method: 'POST', action: `/api/onboarding/hide` },
		)
	}

	if (variant === 'sidebar') {
		const nextStep = progress.steps.find((step) => !step.isCompleted)
		const nextStepHref = getOnboardingStepHref(nextStep, orgSlug)

		return (
			<Link
				to={nextStepHref}
				onClick={(event) => {
					if (
						nextStep?.actionConfig?.type === 'modal' ||
						nextStep?.actionConfig?.type === 'external'
					) {
						event.preventDefault()
						handleStepAction(nextStep)
					}
				}}
				aria-label={t`Get started: ${completedCount} of ${totalSteps} steps complete`}
				className={`group/onboarding border-sidebar-border hover:bg-sidebar-accent/60 focus-visible:ring-sidebar-ring bg-background mx-2 mt-2 block rounded-md border px-3 py-3 transition-colors duration-150 ease-out group-data-[collapsible=icon]:hidden focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none ${className}`}
			>
				<div className="flex items-center justify-between gap-2">
					<span className="text-sidebar-foreground/60 text-xs font-medium">
						<Trans>Get Started</Trans>
					</span>
					<span className="text-sidebar-foreground/60 text-xs tabular-nums">
						{completedCount}/{totalSteps}
					</span>
				</div>

				<div className="mt-1.5 flex items-center gap-2">
					<span className="text-sidebar-foreground min-w-0 flex-1 truncate text-sm font-medium">
						{nextStep ? nextStep.title : <Trans>All steps complete</Trans>}
					</span>
					<Icon
						name={nextStep ? 'chevron-right' : 'check'}
						className="text-sidebar-foreground/40 size-3.5 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none ltr:group-hover/onboarding:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover/onboarding:-translate-x-0.5"
					/>
				</div>

				<Progress
					value={progressPercentage}
					aria-label={t`Onboarding progress`}
					className="**:data-[slot=progress-track]:bg-sidebar-accent mt-3"
				/>
			</Link>
		)
	}

	return (
		<Card className={cn('h-full gap-0 pb-0', className)}>
			<CardHeader className="gap-4 border-b pb-0 sm:flex sm:items-start sm:justify-between">
				<div className="min-w-0 space-y-1">
					<h3
						data-slot="card-title"
						className="text-base leading-snug font-medium"
					>
						<Trans>Get Started</Trans>
					</h3>
					<CardDescription>
						<Trans>
							Complete these steps to get the most from your workspace.
						</Trans>
					</CardDescription>
				</div>

				<CardAction className="flex items-center gap-3">
					<div className="text-right">
						<div className="text-lg tracking-tight tabular-nums">
							{Math.round(progressPercentage)}%
						</div>
						<div className="text-muted-foreground text-xs">
							<Trans>complete</Trans>
						</div>
					</div>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={handleHide}
						disabled={isHiding}
						aria-label={t`Close`}
						aria-busy={isHiding}
					>
						<Icon
							name={isHiding ? 'loader' : 'x'}
							className={cn('size-4', isHiding && 'animate-spin')}
						/>
					</Button>
				</CardAction>
			</CardHeader>

			<div className="bg-muted/30 border-border border-b px-2 py-4">
				<div className="flex items-center justify-between gap-3 text-xs">
					<span className="font-medium">
						<Trans>Your setup progress</Trans>
					</span>
					<span className="text-muted-foreground tabular-nums">
						{completedCount}/{totalSteps}
					</span>
				</div>
				<Progress
					value={progressPercentage}
					aria-label={t`Onboarding progress`}
					className="mt-2"
				/>
			</div>

			<CardContent className="p-0">
				<div className="divide-y">
					{progress.steps.map((step) => (
						<div
							key={step.id}
							className="group hover:bg-muted/40 flex flex-wrap items-start gap-x-3 gap-y-3 px-4 py-4 transition-colors motion-reduce:transition-none sm:flex-nowrap sm:items-center"
						>
							<div
								className={cn(
									'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full sm:mt-0',
									step.isCompleted
										? 'bg-primary text-primary-foreground ring-primary/10 ring-4'
										: 'border-primary/25 bg-primary/5 text-primary border-2',
								)}
							>
								<Icon
									name={
										step.isCompleted
											? 'check'
											: (step.icon as any) || 'check-circle'
									}
									className="size-4"
								/>
							</div>

							<div className="min-w-0 flex-1">
								<h4
									className={cn(
										'text-sm font-medium',
										step.isCompleted
											? 'text-muted-foreground decoration-muted-foreground/50 line-through'
											: 'text-foreground',
									)}
								>
									{step.title}
								</h4>
								<p className="text-muted-foreground mt-1 text-sm leading-relaxed">
									{step.description}
								</p>
							</div>

							<div className="w-full shrink-0 sm:w-auto">
								{step.isCompleted ? (
									<span className="text-muted-foreground flex justify-end text-sm font-medium">
										{step.actionConfig?.completedLabel || (
											<Trans>Completed</Trans>
										)}
									</span>
								) : (
									step.actionConfig && (
										<div className="flex sm:justify-end">
											{step.actionConfig.type === 'navigate' ? (
												<Button
													variant="outline"
													size="sm"
													className="w-full shadow-sm sm:w-auto"
													render={
														<Link
															to={`/${orgSlug}${step.actionConfig.target}`}
															onClick={() => handleStepAction(step)}
														/>
													}
												>
													{step.actionConfig.label}
													<Icon
														name="arrow-right"
														className="size-3.5 ltr:ml-1 rtl:-scale-x-100"
													/>
												</Button>
											) : (
												<Button
													size="sm"
													className="w-full shadow-sm sm:w-auto"
													onClick={() => handleStepAction(step)}
												>
													{step.actionConfig.label}
													<Icon
														name="arrow-right"
														className="size-3.5 ltr:ml-1 rtl:-scale-x-100"
													/>
												</Button>
											)}
										</div>
									)
								)}
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	)
}
