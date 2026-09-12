import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { type ReportScope } from '../catalog.ts'
import { type ReportTemplate, templateCategories } from '../templates.ts'

export type SavedReportSummary = {
	id: string
	title: string
	updatedAt: string
	subject: string
}

function matchesQuery(query: string, values: Array<string | null | undefined>) {
	const needle = query.trim().toLowerCase()
	if (!needle) return true
	return values.some((value) => value?.toLowerCase().includes(needle))
}

export function ReportLibrary({
	scope,
	templates,
	savedReports,
	basePath,
	activeTemplateId,
	compact = false,
}: {
	scope: ReportScope
	templates: ReportTemplate[]
	savedReports: SavedReportSummary[]
	basePath: string
	activeTemplateId?: string | null
	compact?: boolean
}) {
	const [query, setQuery] = useState('')
	const categories = templateCategories(templates)
	const filteredTemplates = useMemo(
		() =>
			templates.filter((template) =>
				matchesQuery(query, [
					template.title,
					template.description,
					template.category,
				]),
			),
		[query, templates],
	)
	const filteredSaved = useMemo(
		() =>
			savedReports.filter((report) =>
				matchesQuery(query, [report.title, report.subject]),
			),
		[query, savedReports],
	)
	const hasMatches = filteredSaved.length > 0 || filteredTemplates.length > 0

	return (
		<aside
			className={cn(
				// Full-height side rail: no rounded corners, no card border.
				// Just a subtle background + a right divider that runs the
				// entire page height, matching the rest of the workspace.
				'bg-muted/20 shrink-0 flex-col gap-4 self-stretch p-4 lg:border-r',
				compact ? 'hidden w-72 lg:flex' : 'flex w-full lg:w-72',
			)}
		>
			<div>
				<p className="text-foreground text-sm">Report Builder</p>
				<p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
					{scope === 'platform'
						? 'Platform counts for operators, orgs, and waitlist.'
						: 'Segment customers, shop orders, notes, members, and feedback.'}
				</p>
			</div>
			<Button
				className="w-full justify-start"
				render={<Link to={`${basePath}/new`} />}
			>
				<Icon name="plus" className="size-4" />
				New Report
			</Button>
			<div className="relative">
				<Icon
					name="search"
					className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4"
				/>
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search templates…"
					aria-label="Search templates"
					className="pl-8"
				/>
			</div>
			<div className="px-0">
				{!hasMatches ? (
					<p className="text-muted-foreground px-2 py-6 text-center text-sm">
						No templates match “{query.trim()}”.
					</p>
				) : null}
				{filteredSaved.length > 0 ? (
					<div className="mb-3">
						<p className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
							Saved
						</p>
						{filteredSaved.map((report) => (
							<Link
								key={report.id}
								to={`${basePath}/${report.id}`}
								className="hover:bg-muted focus-visible:ring-ring/50 block rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2"
							>
								{report.title}
							</Link>
						))}
					</div>
				) : null}
				{categories.map((category) => {
					const items = filteredTemplates.filter(
						(item) => item.category === category,
					)
					if (items.length === 0) return null
					return (
						<Collapsible key={category} defaultOpen className="group mb-1">
							<CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-medium outline-none focus-visible:ring-2">
								{category}
								<Icon
									name="chevron-down"
									className="size-3.5 transition-transform group-data-open:rotate-180"
								/>
							</CollapsibleTrigger>
							<CollapsibleContent>
								{items.map((template) => {
									const active = activeTemplateId === template.id
									return (
										<Link
											key={template.id}
											to={`${basePath}/new?template=${template.id}`}
											className={cn(
												'hover:bg-muted focus-visible:ring-ring/50 block rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2',
												active
													? 'bg-muted text-foreground font-medium'
													: 'text-foreground/90',
											)}
										>
											{template.title}
										</Link>
									)
								})}
							</CollapsibleContent>
						</Collapsible>
					)
				})}
			</div>
		</aside>
	)
}

export function ReportStart({
	heading,
	description,
	templates,
	savedReports,
	basePath,
}: {
	heading: string
	description: string
	templates: ReportTemplate[]
	savedReports: SavedReportSummary[]
	basePath: string
}) {
	const categories = templateCategories(templates)

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-10 py-8 md:px-6 lg:px-8">
			<PageHeader
				title={heading}
				description={description}
				actions={
					<Button render={<Link to={`${basePath}/new`} />}>
						<Icon name="plus" className="size-4" />
						New report
					</Button>
				}
			/>

			{savedReports.length > 0 ? (
				<section className="space-y-3">
					<div className="flex items-baseline justify-between gap-4">
						<h2 className="text-base font-medium">Saved reports</h2>
						<span className="text-muted-foreground text-sm tabular-nums">
							{savedReports.length}
						</span>
					</div>
					<ul className="bg-background divide-y overflow-hidden rounded-xl border">
						{savedReports.map((report) => (
							<li key={report.id}>
								<Link
									to={`${basePath}/${report.id}`}
									className="hover:bg-muted/50 focus-visible:ring-ring/50 flex items-center justify-between gap-4 px-4 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-inset"
								>
									<span className="min-w-0">
										<span className="block truncate text-sm font-medium">
											{report.title}
										</span>
										<span className="text-muted-foreground mt-0.5 block text-xs capitalize">
											{report.subject.replaceAll('-', ' ')}
										</span>
									</span>
									<time
										className="text-muted-foreground shrink-0 text-xs tabular-nums"
										dateTime={report.updatedAt}
										suppressHydrationWarning
									>
										{new Date(report.updatedAt).toLocaleDateString('en-US', {
											timeZone: 'UTC',
										})}
									</time>
								</Link>
							</li>
						))}
					</ul>
				</section>
			) : null}

			<section className="space-y-5">
				<div>
					<h2 className="text-base font-medium">Start from a template</h2>
					<p className="text-muted-foreground mt-1 text-sm">
						Choose a starting point, then refine it in the full-screen builder.
					</p>
				</div>
				<div className="grid gap-6 lg:grid-cols-2">
					{categories.map((category) => {
						const categoryTemplates = templates.filter(
							(template) => template.category === category,
						)
						return (
							<div key={category} className="space-y-3">
								<h3 className="text-muted-foreground text-sm font-medium">
									{category}
								</h3>
								<ul className="bg-background divide-y overflow-hidden rounded-xl border">
									{categoryTemplates.map((template) => (
										<li key={template.id}>
											<Link
												to={`${basePath}/new?template=${template.id}`}
												className="hover:bg-muted/50 focus-visible:ring-ring/50 flex items-start px-4 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-inset"
											>
												<span className="min-w-0 flex-1">
													<span className="block text-sm font-medium">
														{template.title}
													</span>
													<span className="text-muted-foreground mt-0.5 block text-sm leading-relaxed">
														{template.description}
													</span>
												</span>
												<Icon
													name="chevron-right"
													className="text-muted-foreground mt-0.5 size-4 shrink-0"
												/>
											</Link>
										</li>
									))}
								</ul>
							</div>
						)
					})}
				</div>
			</section>
		</div>
	)
}
