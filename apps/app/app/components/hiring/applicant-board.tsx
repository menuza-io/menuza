import {
	type Announcements,
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	PointerSensor,
	pointerWithin,
	TouchSensor,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
	type CollisionDetection,
} from '@dnd-kit/core'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type HiringOpenStage } from '@repo/staffing'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Item, ItemContent, ItemDescription, ItemHeader } from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import { useState } from 'react'
import { Link } from 'react-router'
import { type ApplicantSummary } from '#app/utils/hiring/applicant-types.ts'
import {
	applicantName,
	BOARD_STAGES,
	bySoonestInterview,
	placeLabel,
} from '#app/utils/hiring/applicant-view.ts'
import { FitLabel, FlagNote, useRelativeTime } from './applicant-bits.tsx'
import { type ApplicantLabels } from './applicant-labels.ts'

const collision: CollisionDetection = (args) => {
	const within = args.pointerCoordinates ? pointerWithin(args) : []
	return within.length > 0 ? within : closestCenter(args)
}

type BoardProps = {
	groups: Record<HiringOpenStage, ApplicantSummary[]>
	counts: Record<string, number>
	labels: ApplicantLabels
	scopeName: (scopeId: string | null) => string | null
	timeZoneOf: (scopeId: string | null) => string | null
	/** Where a card opens, with the page's query string kept. */
	hrefFor: (applicant: ApplicantSummary) => string
	canMove: boolean
	onMove: (applicant: ApplicantSummary, stage: HiringOpenStage) => void
}

/**
 * The pipeline as columns. Cards are real links; moving a card works four ways
 * so nobody is left out: drag with a mouse, press and hold the grip on a touch
 * screen, Space and the arrow keys on the grip, or the "Move to" menu on each
 * card (the way most people on a phone will do it). Dropping a card changes its
 * stage on the server and the board follows the answer.
 */
export function ApplicantBoard({
	groups,
	counts,
	labels,
	scopeName,
	timeZoneOf,
	hrefFor,
	canMove,
	onMove,
}: BoardProps) {
	const { _ } = useLingui()
	const [activeId, setActiveId] = useState<string | null>(null)
	const sensors = useSensors(
		// A short drag distance keeps a plain click free to open the card.
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		// Press and hold on the grip, so scrolling the board still works.
		useSensor(TouchSensor, {
			activationConstraint: { delay: 200, tolerance: 8 },
		}),
		useSensor(KeyboardSensor),
	)
	const all = BOARD_STAGES.flatMap((stage) => groups[stage])
	const active = all.find((applicant) => applicant.id === activeId) ?? null

	const announcements: Announcements = {
		onDragStart: ({ active: a }) => {
			const person = all.find((x) => x.id === a.id)
			if (!person) return _(t`Picked up an applicant.`)
			const name = applicantName(person)
			return _(t`Picked up ${name}.`)
		},
		onDragOver: ({ active: a, over }) => {
			const person = all.find((x) => x.id === a.id)
			if (!person || !over) return undefined
			const stage = labels.stage[over.id as HiringOpenStage]
			if (!stage) return undefined
			const name = applicantName(person)
			return _(t`${name} is over ${stage}.`)
		},
		onDragEnd: ({ active: a, over }) => {
			const person = all.find((x) => x.id === a.id)
			if (!person) return undefined
			const name = applicantName(person)
			if (!over) return _(t`${name} was put back.`)
			const stage = labels.stage[over.id as HiringOpenStage]
			return _(t`${name} was dropped in ${stage}.`)
		},
		onDragCancel: ({ active: a }) => {
			const person = all.find((x) => x.id === a.id)
			if (!person) return undefined
			const name = applicantName(person)
			return _(t`Move cancelled. ${name} stays where they were.`)
		},
	}

	function handleEnd(event: DragEndEvent) {
		setActiveId(null)
		const applicant = all.find((x) => x.id === event.active.id)
		const target = event.over?.id as HiringOpenStage | undefined
		if (!applicant || !target || target === applicant.stage) return
		if (!BOARD_STAGES.includes(target)) return
		onMove(applicant, target)
	}

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={collision}
			accessibility={{
				announcements,
				screenReaderInstructions: {
					draggable: _(
						t`To pick up an applicant, press Space. Use the arrow keys to move between columns, then press Space to drop. Press Escape to cancel.`,
					),
				},
			}}
			onDragStart={(event: DragStartEvent) =>
				setActiveId(String(event.active.id))
			}
			onDragEnd={handleEnd}
			onDragCancel={() => setActiveId(null)}
		>
			<div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
				{BOARD_STAGES.map((stage) => (
					<BoardColumn
						key={stage}
						stage={stage}
						applicants={
							stage === 'interview'
								? bySoonestInterview(groups[stage])
								: groups[stage]
						}
						total={counts[stage] ?? groups[stage].length}
						labels={labels}
						scopeName={scopeName}
						timeZoneOf={timeZoneOf}
						hrefFor={hrefFor}
						canMove={canMove}
						onMove={onMove}
					/>
				))}
			</div>
			<DragOverlay>
				{active ? (
					<Card size="sm" className="rotate-3 shadow-lg">
						<CardContent>
							<p className="truncate text-sm font-medium">
								{applicantName(active)}
							</p>
							<p className="text-muted-foreground truncate text-xs">
								{active.postingTitle}
							</p>
						</CardContent>
					</Card>
				) : null}
			</DragOverlay>
		</DndContext>
	)
}

function BoardColumn({
	stage,
	applicants,
	total,
	labels,
	scopeName,
	timeZoneOf,
	hrefFor,
	canMove,
	onMove,
}: {
	stage: HiringOpenStage
	applicants: ApplicantSummary[]
	total: number
	labels: ApplicantLabels
} & Pick<
	BoardProps,
	'scopeName' | 'timeZoneOf' | 'hrefFor' | 'canMove' | 'onMove'
>) {
	const { setNodeRef, isOver } = useDroppable({ id: stage, disabled: !canMove })
	const headingId = `board-${stage}`
	return (
		<section
			aria-labelledby={headingId}
			className="bg-muted/30 flex w-72 shrink-0 flex-col gap-2 rounded-lg p-2 shadow-xs lg:w-auto lg:min-w-0 lg:flex-1"
		>
			<h3
				id={headingId}
				className="flex items-center justify-between gap-2 px-1 pt-1 text-sm"
			>
				<span>{labels.stage[stage]}</span>
				<Badge variant="secondary" className="tabular-nums">
					{total}
				</Badge>
			</h3>
			<ul
				ref={setNodeRef}
				className={cn(
					'flex min-h-24 flex-1 flex-col gap-2 rounded-md p-1 transition-colors',
					isOver && 'bg-muted ring-primary/40 ring-2',
				)}
			>
				{applicants.length === 0 ? (
					<li className="text-muted-foreground border-muted-foreground/30 flex flex-1 items-center justify-center rounded-md border-2 border-dashed px-1 py-6 text-center text-xs">
						<Trans>No one here</Trans>
					</li>
				) : (
					applicants.map((applicant) => (
						<BoardCard
							key={applicant.id}
							applicant={applicant}
							labels={labels}
							scopeName={placeLabel(applicant, scopeName)}
							timeZone={timeZoneOf(applicant.scopeId)}
							href={hrefFor(applicant)}
							canMove={canMove}
							onMove={onMove}
						/>
					))
				)}
			</ul>
		</section>
	)
}

function BoardCard({
	applicant,
	labels,
	scopeName,
	timeZone,
	href,
	canMove,
	onMove,
}: {
	applicant: ApplicantSummary
	labels: ApplicantLabels
	scopeName: string | null
	timeZone: string | null
	href: string
} & Pick<BoardProps, 'canMove' | 'onMove'>) {
	const { _ } = useLingui()
	const relative = useRelativeTime()
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } =
		useDraggable({ id: applicant.id, disabled: !canMove })
	const name = applicantName(applicant)
	const stage = applicant.stage as HiringOpenStage
	const others = BOARD_STAGES.filter((option) => option !== stage)

	return (
		<li ref={setNodeRef} className={cn(isDragging && 'opacity-40')}>
			<Item variant="outline" size="sm">
				<ItemHeader>
					<div className="flex min-w-0 items-center gap-1">
						{canMove ? (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								ref={setActivatorNodeRef}
								{...attributes}
								{...listeners}
								aria-label={_(t`Move ${name}`)}
								className="cursor-grab touch-none active:cursor-grabbing"
							>
								<Icon name="grip-vertical" className="size-4" />
							</Button>
						) : null}
						<Link
							to={href}
							className="focus-visible:ring-ring/50 min-w-0 truncate rounded-sm text-sm font-medium outline-none focus-visible:ring-3"
						>
							{name}
						</Link>
					</div>
					{canMove ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={_(t`Move ${name} to another stage`)}
									>
										<Icon name="ellipsis" />
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								<DropdownMenuGroup>
									<DropdownMenuLabel>
										<Trans>Move to</Trans>
									</DropdownMenuLabel>
									{others.map((option) => (
										<DropdownMenuItem
											key={option}
											onClick={() => onMove(applicant, option)}
										>
											{labels.stage[option]}
										</DropdownMenuItem>
									))}
								</DropdownMenuGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
				</ItemHeader>
				<ItemContent>
					<ItemDescription>
						{[applicant.postingTitle, scopeName].filter(Boolean).join(' · ')}
					</ItemDescription>
					<p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
						<span>{relative(applicant.createdAt)}</span>
						{applicant.interviewAt !== null ? (
							<span className="text-foreground inline-flex items-center gap-1">
								<Icon name="calendar" className="size-3.5 shrink-0" />
								{labels.formatWhen(applicant.interviewAt, timeZone)}
							</span>
						) : null}
					</p>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
						<FlagNote count={applicant.flagCount} />
						<FitLabel score={applicant.screenerScore} labels={labels} />
					</div>
				</ItemContent>
			</Item>
		</li>
	)
}

export function ApplicantBoardSkeleton() {
	return (
		<div
			aria-hidden="true"
			className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0"
		>
			{BOARD_STAGES.map((stage) => (
				<div
					key={stage}
					className="bg-muted/30 flex w-72 shrink-0 flex-col gap-2 rounded-lg p-2 lg:w-auto lg:flex-1"
				>
					<Skeleton className="h-5 w-24" />
					<div className="flex flex-col gap-2 p-1">
						<Skeleton className="h-20 w-full" />
						<Skeleton className="h-20 w-full" />
					</div>
				</div>
			))}
		</div>
	)
}
