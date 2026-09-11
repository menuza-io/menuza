import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
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
		<div className="min-w-0 flex-1">
			<div className="max-w-3xl py-6">
				<h1 className="text-foreground text-2xl tracking-tight">{heading}</h1>
				<p className="text-muted-foreground mt-2 max-w-prose text-sm leading-relaxed">
					{description}
				</p>

				{savedReports.length > 0 ? (
					<section className="mt-10">
						<h2 className="text-foreground text-sm font-semibold">
							Saved reports
						</h2>
						<ul className="mt-3 divide-y border-y">
							{savedReports.map((report) => (
								<li key={report.id}>
									<Link
										to={`${basePath}/${report.id}`}
										className="hover:bg-muted/60 focus-visible:ring-ring/50 flex items-baseline justify-between gap-4 px-1 py-3 outline-none focus-visible:ring-2"
									>
										<span className="text-foreground text-sm font-medium">
											{report.title}
										</span>
										<time
											className="text-muted-foreground text-xs tabular-nums"
											dateTime={report.updatedAt}
										>
											{new Date(report.updatedAt).toLocaleDateString()}
										</time>
									</Link>
								</li>
							))}
						</ul>
					</section>
				) : null}

				{categories.map((category) => (
					<section key={category} className="mt-10">
						<h2 className="text-foreground text-sm font-semibold">
							{category}
						</h2>
						<ul className="mt-3 divide-y border-y">
							{templates
								.filter((template) => template.category === category)
								.map((template) => (
									<li key={template.id}>
										<Link
											to={`${basePath}/new?template=${template.id}`}
											className="hover:bg-muted/60 focus-visible:ring-ring/50 flex items-start justify-between gap-6 px-1 py-3 outline-none focus-visible:ring-2"
										>
											<span>
												<span className="text-foreground block text-sm font-medium">
													{template.title}
												</span>
												<span className="text-muted-foreground mt-0.5 block text-sm leading-relaxed">
													{template.description}
												</span>
											</span>
											<span className="text-primary mt-0.5 shrink-0 text-sm font-medium">
												Open
											</span>
										</Link>
									</li>
								))}
						</ul>
					</section>
				))}
			</div>
		</div>
	)
}
