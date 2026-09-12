import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon, type IconName } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Textarea } from '@repo/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/tooltip'
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import {
	type ReportCatalog,
	defaultListColumns,
	filterableFields,
	getField,
	getSubject,
	groupableFields,
	listableFields,
	timeframeFields,
} from '../catalog.ts'
import {
	type ReportDefinition,
	type ReportResult,
	type ReportRunError,
	countFilterConditions,
	emptyFilterGroup,
	flattenFilterConditions,
	isListReport,
} from '../dsl.ts'
import { timeBucketLabel, timeframePresetLabel } from '../engine.ts'
import { FilterEditor } from './filter-editor.tsx'
import { ReportVisualization } from './report-chart.tsx'
import { ReportExportMenu } from './report-export.tsx'

type BuilderPanel =
	'subject' | 'visualization' | 'filters' | 'group' | 'settings'

const PANEL_LABELS: Record<BuilderPanel, string> = {
	subject: 'Subject',
	visualization: 'Visualization',
	filters: 'Filters',
	group: 'Group',
	settings: 'Settings',
}

function HelpTip({ label, text }: { label: string; text: string }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm outline-none focus-visible:ring-2"
						aria-label={label}
						onClick={(event) => event.stopPropagation()}
					>
						<Icon name="help-circle" className="size-3.5" />
					</button>
				}
			/>
			<TooltipContent>{text}</TooltipContent>
		</Tooltip>
	)
}

function ConfigCard({
	icon,
	label,
	tooltip,
	active,
	children,
	onClick,
}: {
	icon: IconName
	label: string
	tooltip: string
	active?: boolean
	children: React.ReactNode
	onClick?: () => void
}) {
	return (
		<div className="relative min-w-52 flex-1">
			<button
				type="button"
				onClick={onClick}
				aria-pressed={active}
				className={cn(
					'bg-background hover:border-primary/40 focus-visible:ring-ring/50 h-full w-full cursor-pointer rounded-xl border p-3 text-left outline-none focus-visible:ring-2',
					active ? 'border-primary ring-primary/20 ring-2' : 'border-border',
				)}
			>
				<div className="text-muted-foreground mb-2 flex items-center gap-1.5 pr-5 text-xs font-medium">
					<Icon name={icon} className="size-3.5" />
					{label}
				</div>
				<div className="text-primary truncate text-sm font-medium">
					{children}
				</div>
			</button>
			<div className="absolute top-3 right-3">
				<HelpTip label={`${label} help`} text={tooltip} />
			</div>
		</div>
	)
}

function RailButton({
	icon,
	label,
	active,
	badge,
	onClick,
}: {
	icon: IconName
	label: string
	active: boolean
	badge?: number
	onClick: () => void
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						aria-label={label}
						aria-pressed={active}
						className={cn(
							'focus-visible:ring-ring/50 relative flex size-10 items-center justify-center rounded-md outline-none focus-visible:ring-2',
							active
								? 'bg-muted text-foreground'
								: 'text-muted-foreground hover:bg-muted/70',
						)}
					>
						<Icon name={icon} className="size-4" />
						{badge ? (
							<span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums">
								{badge}
							</span>
						) : null}
					</button>
				}
			/>
			<TooltipContent side="left">{label}</TooltipContent>
		</Tooltip>
	)
}

function subscribeToCompactViewport(callback: () => void) {
	const mql = window.matchMedia('(max-width: 767px)')
	mql.addEventListener('change', callback)
	return () => mql.removeEventListener('change', callback)
}

export function ReportBuilder({
	catalog,
	definition,
	onChange,
	result,
	error,
	loading,
	onSave,
	saving,
	saveError,
	updatedAt,
	backHref,
	hasTenantDb,
	headerExtras,
	contentClassName,
}: {
	catalog: ReportCatalog
	definition: ReportDefinition
	onChange: (next: ReportDefinition) => void
	result: ReportResult | null
	error: ReportRunError | string | null
	loading: boolean
	onSave: () => void
	saving?: boolean
	saveError?: string | null
	updatedAt?: Date | null
	backHref: string
	hasTenantDb?: boolean
	headerExtras?: React.ReactNode
	contentClassName?: string
}) {
	const isCompact = useSyncExternalStore(
		subscribeToCompactViewport,
		() => window.matchMedia('(max-width: 767px)').matches,
		() => false,
	)
	const [desktopPanel, setDesktopPanel] =
		useState<BuilderPanel>('visualization')
	const [compactPanel, setCompactPanel] = useState<BuilderPanel | null>(null)
	const panel = isCompact ? compactPanel : desktopPanel
	const chartRef = useRef<HTMLDivElement>(null)
	const subject = getSubject(catalog, definition.subject)
	const groupFields = subject ? groupableFields(subject) : []
	const columnFields = subject ? listableFields(subject) : []
	const timeFields = subject ? timeframeFields(subject) : []
	const filterFields = subject ? filterableFields(subject) : []
	const filterCount = countFilterConditions(definition.filters)
	const listMode = isListReport(definition)
	const groupCount = listMode
		? definition.columns.length
		: definition.groupBy.length

	const selectedGroup = useMemo(
		() => groupFields.filter((field) => definition.groupBy.includes(field.id)),
		[definition.groupBy, groupFields],
	)
	const selectedColumns = useMemo(() => {
		if (!subject) return []
		return definition.columns
			.map((id) => getField(subject, id))
			.filter((field): field is NonNullable<typeof field> => Boolean(field))
	}, [definition.columns, subject])
	const groupedField = selectedGroup[0]
	const datetimeGrouped = groupedField?.type === 'datetime'

	function update(patch: Partial<ReportDefinition>) {
		onChange({ ...definition, ...patch })
	}

	function togglePanel(next: BuilderPanel) {
		if (isCompact) {
			setCompactPanel((current) => (current === next ? null : next))
		} else {
			setDesktopPanel(next)
		}
	}

	function closePanel() {
		if (isCompact) {
			setCompactPanel(null)
		}
	}

	const tenantApiSubject = subject?.source === 'tenant-api'
	const timeframeFieldLabel =
		timeFields.find((field) => field.id === definition.timeframe.field)
			?.label ?? definition.timeframe.field
	return (
		<div className="bg-background flex h-full min-h-0 flex-col overflow-hidden">
			<header className="border-border bg-background flex h-12 shrink-0 items-center border-b px-3">
				<div className="flex w-full items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-3">
						<Link
							to={backHref}
							aria-label="Back to reports"
							className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
						>
							<Icon name="arrow-left" className="size-4" />
						</Link>
						<div className="bg-border hidden h-5 w-px sm:block" aria-hidden />
						<div className="min-w-0 flex-1">
							<h1 className="text-foreground truncate text-base leading-tight font-semibold">
								{definition.settings.title || 'New Report'}
							</h1>
							{definition.settings.notes ? (
								<p className="text-muted-foreground mt-0.5 truncate text-sm leading-snug">
									{definition.settings.notes}
								</p>
							) : null}
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{updatedAt ? (
							<p className="text-muted-foreground hidden text-xs tabular-nums sm:block">
								{loading ? 'Updating…' : 'Updated just now'}
							</p>
						) : null}
						{headerExtras}
						<div className="hidden sm:block">
							<ReportExportMenu
								definition={definition}
								result={result}
								error={error}
								chartRef={chartRef}
							/>
						</div>
						<Button onClick={onSave} disabled={saving}>
							{saving ? 'Saving…' : 'Save Report'}
						</Button>
					</div>
				</div>
			</header>

			{saveError ? (
				<p className="text-destructive border-b px-4 py-2 text-sm">
					{saveError}
				</p>
			) : null}

			<div
				className={cn(
					'bg-muted relative flex min-h-0 min-w-0 flex-1 gap-2 p-2',
					contentClassName,
				)}
			>
				<div className="bg-background flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border shadow-sm md:order-last">
					{tenantApiSubject && hasTenantDb === false ? (
						<div className="bg-muted/50 text-muted-foreground m-4 rounded-lg border px-3 py-2 text-sm leading-relaxed">
							This organization has not provisioned a regional customer database
							yet. Publish the public site to collect data, then rerun this
							report. Customer and shop records are queried from the regional
							tenant API in the browser and are never copied to the US control
							plane.
						</div>
					) : null}
					<div className="flex snap-x [scrollbar-width:none] gap-3 overflow-x-auto border-b p-3 [&::-webkit-scrollbar]:hidden">
						<ConfigCard
							icon="database"
							label="Subject"
							tooltip="The subject of the report is the type of record being split into segments."
							active={panel === 'subject'}
							onClick={() => togglePanel('subject')}
						>
							{subject?.label ?? 'Select a subject'}
						</ConfigCard>
						<ConfigCard
							icon="calendar"
							label="Timeframe"
							tooltip="Choose the field and date range used to include records."
							onClick={() => togglePanel('subject')}
						>
							{timeframeFieldLabel} ·{' '}
							{timeframePresetLabel(definition.timeframe.preset)}
						</ConfigCard>
						<ConfigCard
							icon="layout-grid"
							label={listMode ? 'Columns' : 'Group results by'}
							tooltip={
								listMode
									? 'Choose which fields appear in the table.'
									: 'Choose how results are segmented.'
							}
							active={panel === 'group'}
							onClick={() => togglePanel('group')}
						>
							{listMode ? (
								selectedColumns.length > 0 ? (
									selectedColumns.map((field) => field.label).join(', ')
								) : (
									<span className="text-destructive">Select columns…</span>
								)
							) : selectedGroup.length > 0 ? (
								<>
									{selectedGroup.map((field) => field.label).join(', ')}
									{datetimeGrouped
										? ` · ${timeBucketLabel(definition.timeBucket)}`
										: null}
								</>
							) : (
								<span className="text-destructive">Select a field…</span>
							)}
						</ConfigCard>
					</div>
					<div className="relative flex min-h-0 flex-1">
						<ReportVisualization
							definition={definition}
							result={result}
							error={error}
							loading={loading}
							containerRef={chartRef}
						/>
						<nav className="bg-muted/30 absolute inset-x-2 bottom-2 z-10 flex h-12 items-center justify-center gap-1 rounded-lg border p-1 shadow-sm md:hidden">
							<RailButton
								icon="database"
								label="Subject"
								active={panel === 'subject'}
								onClick={() => togglePanel('subject')}
							/>
							<RailButton
								icon="activity"
								label="Visualization"
								active={panel === 'visualization'}
								onClick={() => togglePanel('visualization')}
							/>
							<RailButton
								icon="search"
								label="Filters"
								active={panel === 'filters'}
								badge={filterCount}
								onClick={() => togglePanel('filters')}
							/>
							<RailButton
								icon="layout-grid"
								label={listMode ? 'Columns' : 'Group'}
								active={panel === 'group'}
								badge={groupCount}
								onClick={() => togglePanel('group')}
							/>
							<RailButton
								icon="gear"
								label="Settings"
								active={panel === 'settings'}
								onClick={() => togglePanel('settings')}
							/>
						</nav>
					</div>
				</div>

				{panel ? (
					<aside className="bg-background absolute inset-x-2 top-2 bottom-16 z-20 overflow-hidden rounded-xl border shadow-md md:static md:order-first md:flex md:w-80 md:shrink-0 md:shadow-sm">
						<nav className="bg-muted/30 hidden w-12 shrink-0 flex-col items-center gap-1 border-r py-3 md:flex">
							<RailButton
								icon="database"
								label="Subject"
								active={panel === 'subject'}
								onClick={() => togglePanel('subject')}
							/>
							<RailButton
								icon="activity"
								label="Visualization"
								active={panel === 'visualization'}
								onClick={() => togglePanel('visualization')}
							/>
							<RailButton
								icon="search"
								label="Filters"
								active={panel === 'filters'}
								badge={filterCount}
								onClick={() => togglePanel('filters')}
							/>
							<RailButton
								icon="layout-grid"
								label={listMode ? 'Columns' : 'Group'}
								active={panel === 'group'}
								badge={groupCount}
								onClick={() => togglePanel('group')}
							/>
							<RailButton
								icon="gear"
								label="Settings"
								active={panel === 'settings'}
								onClick={() => togglePanel('settings')}
							/>
						</nav>
						<div className="flex h-full min-w-0 flex-1 flex-col">
							<div className="flex items-center justify-between border-b px-4 py-3">
								<h2 className="text-sm font-semibold">
									{panel === 'group' && listMode
										? 'Columns'
										: panel
											? PANEL_LABELS[panel]
											: 'Report settings'}
								</h2>
								<Button
									variant="ghost"
									size="icon-sm"
									className="md:hidden"
									aria-label="Close panel"
									onClick={closePanel}
								>
									<Icon name="x" className="size-4" />
								</Button>
							</div>
							<div className="space-y-4 overflow-y-auto p-4">
								{panel === 'subject' ? (
									<>
										<div className="space-y-2">
											<Label>Subject</Label>
											<Select
												value={definition.subject}
												onValueChange={(value) => {
													if (!value) return
													const next = getSubject(catalog, value)
													const timeframeField =
														next?.fields.find((field) => field.timeframe)?.id ??
														'createdAt'
													const nextList =
														definition.visualization.chartStyle === 'table'
													update({
														subject: value,
														timeframe: {
															...definition.timeframe,
															field: timeframeField,
														},
														groupBy: [],
														columns:
															nextList && next ? defaultListColumns(next) : [],
														filters: emptyFilterGroup(),
													})
												}}
											>
												<SelectTrigger className="w-full">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{catalog.subjects.map((item) => (
														<SelectItem key={item.id} value={item.id}>
															{item.label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
										<div className="space-y-2">
											<Label>Timeframe field</Label>
											<Select
												value={definition.timeframe.field}
												onValueChange={(value) => {
													if (!value) return
													update({
														timeframe: {
															...definition.timeframe,
															field: value,
														},
													})
												}}
											>
												<SelectTrigger className="w-full">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{timeFields.map((field) => (
														<SelectItem key={field.id} value={field.id}>
															{field.label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
										<div className="space-y-2">
											<Label>Range</Label>
											<Select
												value={definition.timeframe.preset}
												onValueChange={(value) => {
													if (!value) return
													update({
														timeframe: {
															...definition.timeframe,
															preset:
																value as ReportDefinition['timeframe']['preset'],
														},
													})
												}}
											>
												<SelectTrigger className="w-full">
													<SelectValue>
														{timeframePresetLabel(definition.timeframe.preset)}
													</SelectValue>
												</SelectTrigger>
												<SelectContent>
													{(
														[
															'today',
															'last_7_days',
															'last_30_days',
															'last_3_months',
															'last_6_months',
															'last_12_months',
															'all_time',
														] as const
													).map((preset) => (
														<SelectItem key={preset} value={preset}>
															{timeframePresetLabel(preset)}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									</>
								) : null}

								{panel === 'visualization' ? (
									<>
										<div className="space-y-2">
											<Label>Chart Style</Label>
											<Select
												value={definition.visualization.chartStyle}
												onValueChange={(value) => {
													if (!value) return
													const chartStyle =
														value as ReportDefinition['visualization']['chartStyle']
													if (chartStyle === 'table') {
														update({
															visualization: {
																...definition.visualization,
																chartStyle,
															},
															groupBy: [],
															columns:
																definition.columns.length > 0
																	? definition.columns
																	: subject
																		? defaultListColumns(subject)
																		: [],
														})
														return
													}
													const nextGroupBy = definition.groupBy
													const groupedType =
														nextGroupBy[0] && subject
															? getField(subject, nextGroupBy[0])?.type
															: undefined
													const nextStyle =
														chartStyle === 'pie' && groupedType === 'datetime'
															? 'bar'
															: chartStyle
													update({
														visualization: {
															...definition.visualization,
															chartStyle: nextStyle,
														},
														columns:
															definition.visualization.chartStyle === 'table'
																? []
																: definition.columns,
													})
												}}
											>
												<SelectTrigger className="w-full">
													<SelectValue>
														{
															{
																pie: 'Pie Chart',
																bar: 'Bar Chart',
																single_number: 'Single Number',
																table: 'Table',
															}[definition.visualization.chartStyle]
														}
													</SelectValue>
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="pie">Pie Chart</SelectItem>
													<SelectItem value="bar">Bar Chart</SelectItem>
													<SelectItem value="single_number">
														Single Number
													</SelectItem>
													<SelectItem value="table">Table</SelectItem>
												</SelectContent>
											</Select>
										</div>
										{listMode ? null : (
											<>
												<div className="space-y-2">
													<Label>Measure</Label>
													<Select
														value={definition.visualization.measure}
														onValueChange={(value) => {
															if (!value) return
															update({
																visualization: {
																	...definition.visualization,
																	measure:
																		value as ReportDefinition['visualization']['measure'],
																},
															})
														}}
													>
														<SelectTrigger className="w-full">
															<SelectValue>
																{definition.visualization.measure === 'percent'
																	? 'Percent'
																	: 'Count'}
															</SelectValue>
														</SelectTrigger>
														<SelectContent>
															<SelectItem value="count">Count</SelectItem>
															<SelectItem value="percent">Percent</SelectItem>
														</SelectContent>
													</Select>
												</div>
												<div className="space-y-2">
													<Label>Sort By</Label>
													<Select
														value={definition.visualization.sortBy}
														onValueChange={(value) => {
															if (!value) return
															update({
																visualization: {
																	...definition.visualization,
																	sortBy:
																		value as ReportDefinition['visualization']['sortBy'],
																},
															})
														}}
													>
														<SelectTrigger className="w-full">
															<SelectValue>
																{
																	{
																		none: 'None',
																		label: 'Label',
																		value_asc: 'Value (asc)',
																		value_desc: 'Value (desc)',
																	}[definition.visualization.sortBy]
																}
															</SelectValue>
														</SelectTrigger>
														<SelectContent>
															<SelectItem value="none">None</SelectItem>
															<SelectItem value="label">Label</SelectItem>
															<SelectItem value="value_asc">
																Value (asc)
															</SelectItem>
															<SelectItem value="value_desc">
																Value (desc)
															</SelectItem>
														</SelectContent>
													</Select>
												</div>
												<div className="space-y-2">
													<Label className="flex items-center gap-1">
														Hide Counts
														<HelpTip
															label="Hide counts help"
															text="Hide raw counts and show only percentages."
														/>
													</Label>
													<Checkbox
														checked={definition.visualization.hideCounts}
														onCheckedChange={(checked) =>
															update({
																visualization: {
																	...definition.visualization,
																	hideCounts: checked === true,
																},
															})
														}
													/>
												</div>
											</>
										)}
									</>
								) : null}

								{panel === 'filters' ? (
									<FilterEditor
										group={definition.filters}
										advanced={definition.advancedFilters}
										fields={filterFields}
										onChange={(filters) => update({ filters })}
										onToggleAdvanced={(enabled) =>
											update({
												advancedFilters: enabled,
												filters: enabled
													? definition.filters
													: {
															combinator: 'and',
															conditions: flattenFilterConditions(
																definition.filters,
															),
														},
											})
										}
									/>
								) : null}

								{panel === 'group' ? (
									listMode ? (
										<div className="space-y-3">
											<Label>Table columns</Label>
											<p className="text-muted-foreground text-xs leading-relaxed">
												Add the fields you want as columns. Up to 8 columns.
											</p>
											<div className="space-y-2">
												{columnFields.map((field) => {
													const checked = definition.columns.includes(field.id)
													const atLimit =
														!checked && definition.columns.length >= 8
													return (
														<label
															key={field.id}
															className="flex items-center gap-2 text-sm"
														>
															<Checkbox
																checked={checked}
																disabled={atLimit}
																onCheckedChange={(value) => {
																	if (value === true) {
																		if (definition.columns.length >= 8) return
																		update({
																			columns: [
																				...definition.columns,
																				field.id,
																			],
																		})
																		return
																	}
																	if (definition.columns.length <= 1) return
																	update({
																		columns: definition.columns.filter(
																			(id) => id !== field.id,
																		),
																	})
																}}
															/>
															<span>{field.label}</span>
														</label>
													)
												})}
											</div>
										</div>
									) : (
										<div className="space-y-4">
											<div className="space-y-2">
												<Label>Group Results By</Label>
												<Select
													value={definition.groupBy[0]}
													onValueChange={(value) => {
														const field = value
															? subject
																? getField(subject, value)
																: null
															: null
														const nextStyle =
															definition.visualization.chartStyle === 'pie' &&
															field?.type === 'datetime'
																? 'bar'
																: definition.visualization.chartStyle
														update({
															groupBy: value ? [value] : [],
															visualization: {
																...definition.visualization,
																chartStyle: nextStyle,
															},
														})
													}}
												>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Select a field…">
															{groupedField?.label}
														</SelectValue>
													</SelectTrigger>
													<SelectContent>
														{groupFields.map((field) => (
															<SelectItem key={field.id} value={field.id}>
																{field.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												<p className="text-muted-foreground text-xs leading-relaxed">
													Further group results by a field related to the
													subject of the report.
												</p>
											</div>
											{datetimeGrouped ? (
												<div className="space-y-2">
													<Label>Breakdown</Label>
													<Select
														value={definition.timeBucket}
														onValueChange={(value) => {
															if (!value) return
															update({
																timeBucket:
																	value as ReportDefinition['timeBucket'],
																visualization: {
																	...definition.visualization,
																	chartStyle:
																		definition.visualization.chartStyle ===
																		'pie'
																			? 'bar'
																			: definition.visualization.chartStyle,
																},
															})
														}}
													>
														<SelectTrigger className="w-full">
															<SelectValue>
																{timeBucketLabel(definition.timeBucket)}
															</SelectValue>
														</SelectTrigger>
														<SelectContent>
															<SelectItem value="week">Weekly</SelectItem>
															<SelectItem value="month">Monthly</SelectItem>
														</SelectContent>
													</Select>
													<p className="text-muted-foreground text-xs leading-relaxed">
														Bucket dates into calendar weeks (Monday–Sunday,
														UTC) or calendar months.
													</p>
												</div>
											) : null}
										</div>
									)
								) : null}

								{panel === 'settings' ? (
									<>
										<div className="space-y-2">
											<Label htmlFor="report-title">Title</Label>
											<Input
												id="report-title"
												value={definition.settings.title}
												onChange={(event) =>
													update({
														settings: {
															...definition.settings,
															title: event.target.value,
														},
													})
												}
											/>
										</div>
										<div className="space-y-2">
											<Label htmlFor="report-notes">Notes</Label>
											<Textarea
												id="report-notes"
												value={definition.settings.notes}
												placeholder="Add an optional note…"
												onChange={(event) =>
													update({
														settings: {
															...definition.settings,
															notes: event.target.value,
														},
													})
												}
											/>
										</div>
										<div className="space-y-2">
											<Label>Timezone</Label>
											<Select
												value={definition.settings.timezone}
												onValueChange={(value) => {
													if (!value) return
													update({
														settings: {
															...definition.settings,
															timezone: value,
														},
													})
												}}
											>
												<SelectTrigger className="w-full">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="user">User Timezone</SelectItem>
													<SelectItem value="UTC">UTC</SelectItem>
												</SelectContent>
											</Select>
											<p className="text-muted-foreground text-xs">
												{definition.settings.timezone === 'user'
													? Intl.DateTimeFormat().resolvedOptions().timeZone
													: 'UTC'}
											</p>
										</div>
									</>
								) : null}
							</div>
						</div>
					</aside>
				) : null}
			</div>
		</div>
	)
}
