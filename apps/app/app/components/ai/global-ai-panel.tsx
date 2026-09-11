'use client'

import { Trans, useLingui } from '@lingui/react/macro'
import { cn, useIsMobile } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Component,
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	type ErrorInfo,
	type ReactNode,
} from 'react'
import {
	useFetcher,
	useLocation,
	useNavigate,
	useParams,
	useRouteLoaderData,
} from 'react-router'
import { type loader as rootLoader } from '#app/root.tsx'
import { resolveAppNavPath } from '#app/utils/ai/app-nav-routes.ts'
import { useAIPanel } from './ai-panel-context'

/**
 * Full-viewport builder routes. The AI panel docks and uses a higher z-index
 * tier on these so it isn't covered by the editor's own fixed overlay.
 */
const BUILDER_PATH =
	/\/(?:website\/(?:pages|forms)|marketing\/automations)\/[^/]+$/

function useIsBuilderRoute() {
	const location = useLocation()
	return BUILDER_PATH.test(location.pathname)
}

// Lazy-load the AIChat component (and the heavy @repo/ai dependency tree)
// so the dashboard never pays the cost until the panel is first opened.
const AIChat = lazy(() =>
	import('@repo/ai').then((module) => ({ default: module.AIChat })),
)

class PanelErrorBoundary extends Component<
	{ children: ReactNode; fallback: ReactNode },
	{ hasError: boolean }
> {
	constructor(props: { children: ReactNode; fallback: ReactNode }) {
		super(props)
		this.state = { hasError: false }
	}

	static getDerivedStateFromError() {
		return { hasError: true }
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error('GlobalAIChat failed to load:', error, info)
	}

	render() {
		if (this.state.hasError) return this.props.fallback
		return this.props.children
	}
}

function LoadingShell() {
	return (
		<div className="text-muted-foreground flex h-full items-center justify-center text-sm">
			<Trans>Loading assistant…</Trans>
		</div>
	)
}

function ErrorShell({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
			<p className="text-muted-foreground">
				<Trans>Couldn't load the assistant.</Trans>
			</p>
			<Button variant="outline" size="sm" onClick={onRetry}>
				<Trans>Try again</Trans>
			</Button>
		</div>
	)
}

function CloseButton() {
	const { close } = useAIPanel()
	const { i18n } = useLingui()
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			type="button"
			onClick={(e) => {
				e.stopPropagation()
				close()
			}}
			aria-label={i18n._('Close assistant')}
		>
			<Icon name="x" className="size-4" />
		</Button>
	)
}

function ExpandButton() {
	const { isExpanded, toggleExpanded } = useAIPanel()
	const { i18n } = useLingui()
	const label = isExpanded
		? i18n._('Exit full screen')
		: i18n._('Open full screen')
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			type="button"
			onClick={(e) => {
				e.stopPropagation()
				toggleExpanded()
			}}
			aria-label={label}
			aria-pressed={isExpanded}
			title={label}
		>
			<Icon
				name={isExpanded ? 'minimize-2' : 'maximize-2'}
				className="size-4"
			/>
		</Button>
	)
}

function getToolInput(toolCall: { input?: unknown; args?: unknown }) {
	const raw = toolCall.input ?? toolCall.args
	if (raw && typeof raw === 'object') {
		return raw as Record<string, unknown>
	}
	return {}
}

function asString(value: unknown) {
	if (typeof value === 'string') return value
	if (typeof value === 'number') return String(value)
	if (value == null) return ''
	return JSON.stringify(value)
}

function PanelBody() {
	const isBuilderRoute = useIsBuilderRoute()
	const params = useParams()
	const location = useLocation()
	const fetcher = useFetcher()
	const navigate = useNavigate()
	const rootData = useRouteLoaderData<typeof rootLoader>('root')
	const pageId = params.pageId
	const orgSlug =
		params.orgSlug ??
		rootData?.userOrganizations?.currentOrganization?.organization.slug

	const routeParams = useMemo(() => {
		const next: Record<string, string> = {}
		for (const [key, value] of Object.entries(params)) {
			if (typeof value === 'string') next[key] = value
		}
		if (orgSlug && !next.orgSlug) next.orgSlug = orgSlug
		return next
	}, [params, orgSlug])

	const currentPath = `${location.pathname}${location.search}`

	const openPageEditor = useCallback(
		(targetPageId: string) => {
			if (!orgSlug) return
			if (targetPageId === pageId) return
			void navigate(`/${orgSlug}/website/pages/${targetPageId}`)
		},
		[navigate, orgSlug, pageId],
	)

	const handleToolCall = useCallback(
		async ({ toolCall }: { toolCall: any }) => {
			const input = getToolInput(toolCall)

			if (toolCall.toolName === 'navigateToAppPage') {
				const resolved = resolveAppNavPath(asString(input.routeId), {
					orgSlug,
				})
				if (!resolved.ok) return resolved.error
				if (
					location.pathname === resolved.path ||
					currentPath === resolved.path
				) {
					return `Already on ${resolved.route.title}`
				}
				void navigate(resolved.path)
				return `Opened ${resolved.route.title}`
			}

			if (!orgSlug) return 'Error: Not in an organization'

			if (toolCall.toolName === 'createPage') {
				try {
					const formData = new FormData()
					formData.append('intent', 'create-page')
					formData.append('title', asString(input.title))
					formData.append('slug', asString(input.slug))
					formData.append('template', asString(input.template))

					const response = await fetch(`/${orgSlug}/website/pages`, {
						method: 'POST',
						body: formData,
						credentials: 'same-origin',
					})
					const result = (await response.json()) as {
						status?: string
						pageId?: string
					}

					if (!response.ok || result.status !== 'success' || !result.pageId) {
						return 'Error: Could not create the page. The title or URL slug may already exist.'
					}

					openPageEditor(result.pageId)
					return `Created page "${asString(input.title)}" and opened its editor.`
				} catch {
					return 'Error: Could not create the page.'
				}
			}

			const targetPageId = asString(input.pageId) || pageId

			if (toolCall.toolName === 'navigateToPage') {
				if (!targetPageId) return 'Error: Missing pageId'
				openPageEditor(targetPageId)
				return `Opened the page editor for ${targetPageId}`
			}

			if (!targetPageId) {
				return 'Error: Missing pageId. Navigate to a page editor or pass pageId.'
			}

			// Open the target page editor first so the user can see the change,
			// even when the request started from the dashboard or another page.
			openPageEditor(targetPageId)

			const action = `/${orgSlug}/website/pages/${targetPageId}`

			if (toolCall.toolName === 'addSection') {
				void fetcher.submit(
					{
						intent: 'add-section',
						type: asString(input.type),
						position: asString(input.position),
						config: asString(input.config),
					},
					{
						method: 'POST',
						action,
					},
				)
				return 'Section added successfully'
			}

			if (toolCall.toolName === 'updateSection') {
				void fetcher.submit(
					{
						intent: 'update-section',
						sectionId: asString(input.sectionId),
						config: asString(input.config),
					},
					{
						method: 'POST',
						action,
					},
				)
				return 'Section updated successfully'
			}

			if (toolCall.toolName === 'removeSection') {
				void fetcher.submit(
					{
						intent: 'remove-section',
						sectionId: asString(input.sectionId),
					},
					{
						method: 'POST',
						action,
					},
				)
				return 'Section removed successfully'
			}

			return 'Unknown tool'
		},
		[
			currentPath,
			fetcher,
			location.pathname,
			navigate,
			openPageEditor,
			orgSlug,
			pageId,
		],
	)

	const resolveDestinationLabel = useCallback(
		(toolName: string, input: Record<string, unknown>) => {
			if (toolName === 'navigateToAppPage') {
				const resolved = resolveAppNavPath(asString(input.routeId), {
					orgSlug,
				})
				if (resolved.ok) return resolved.route.title
			}

			if (toolName === 'navigateToPage') {
				const pageTitle = asString(input.title).trim()
				if (pageTitle) return pageTitle
				return 'the page editor'
			}

			return undefined
		},
		[orgSlug],
	)

	return (
		<>
			<header
				className={cn(
					'flex w-full shrink-0 items-center justify-between border-b transition-[width,height] ease-linear',
					isBuilderRoute ? 'h-12' : 'h-(--header-height)',
				)}
			>
				<div className="flex items-center px-4">
					<span className="text-md font-medium tracking-normal">
						<Trans>AI Assistant</Trans>
					</span>
				</div>
				<div className="flex items-center justify-end gap-0.5 px-2 pr-3 md:pr-4">
					<div className={cn(!isBuilderRoute && 'hidden md:contents')}>
						<ExpandButton />
					</div>
					<CloseButton />
				</div>
			</header>

			<div className="min-h-0 flex-1">
				<PanelErrorBoundary
					fallback={<ErrorShell onRetry={() => window.location.reload()} />}
				>
					<Suspense fallback={<LoadingShell />}>
						<AIChat
							persistKey="global-assistant"
							pageId={pageId}
							orgSlug={orgSlug}
							currentPath={currentPath}
							routeParams={routeParams}
							onToolCall={handleToolCall}
							resolveDestinationLabel={resolveDestinationLabel}
						/>
					</Suspense>
				</PanelErrorBoundary>
			</div>
		</>
	)
}

function AIPanelSurface() {
	const { isOpen, isExpanded, close, collapse, hasActivated } = useAIPanel()
	const { i18n } = useLingui()
	const isMobile = useIsMobile()
	const isBuilderRoute = useIsBuilderRoute()
	const isFullscreen = isOpen && isExpanded
	const isVisible = isOpen || isFullscreen
	const hasEverMountedRef = useRef(false)
	if (hasActivated) hasEverMountedRef.current = true

	useEffect(() => {
		if (!isOpen) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return
			if (isMobile) close()
			else if (isExpanded) collapse()
			else close()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [isOpen, isExpanded, isMobile, close, collapse])

	useEffect(() => {
		const shouldLockScroll = isMobile ? isOpen : isFullscreen
		if (!shouldLockScroll) return
		const previous = document.body.style.overflow
		document.body.style.overflow = 'hidden'
		return () => {
			document.body.style.overflow = previous
		}
	}, [isFullscreen, isMobile, isOpen])

	if (!hasEverMountedRef.current) return null

	return (
		<>
			{!isMobile && isFullscreen ? (
				<button
					type="button"
					tabIndex={-1}
					aria-label={i18n._('Exit full screen')}
					onClick={collapse}
					className={cn(
						'animate-in fade-in-0 fixed inset-0 bg-black/10 duration-200 supports-backdrop-filter:backdrop-blur-xs',
						isBuilderRoute ? 'z-60' : 'z-40',
					)}
				/>
			) : null}

			<aside
				role={isFullscreen || isMobile ? 'dialog' : undefined}
				aria-modal={isFullscreen || isMobile || undefined}
				aria-label={i18n._('AI assistant')}
				aria-hidden={!isVisible}
				className={cn(
					'bg-background flex flex-col overflow-hidden',
					!isVisible && 'pointer-events-none',
					isMobile &&
						cn(
							'fixed inset-0',
							isBuilderRoute ? 'z-60' : 'z-50',
							!isOpen && 'invisible',
						),
					!isMobile &&
						isFullscreen &&
						cn(
							'ring-foreground/10 animate-in fade-in-0 zoom-in-95 fixed rounded-xl shadow-lg ring-1 duration-200',
							isBuilderRoute
								? 'inset-3 z-70 sm:inset-4'
								: 'inset-3 z-50 sm:inset-4',
						),
					!isMobile &&
						!isFullscreen &&
						isBuilderRoute &&
						cn(
							'fixed top-14 right-2 bottom-2 z-80 rounded-xl shadow-sm',
							!isVisible && 'hidden',
						),
					!isMobile &&
						!isFullscreen &&
						!isBuilderRoute &&
						cn(
							'fixed top-2 right-2 bottom-2 z-40 rounded-xl shadow-sm',
							'transition-[width,opacity] duration-300 ease-out',
							isVisible ? 'w-105 opacity-100' : 'w-0 opacity-0',
						),
				)}
			>
				<div
					className={cn(
						'flex h-full flex-col',
						isMobile || isFullscreen ? 'w-full' : 'w-105',
					)}
				>
					<PanelBody />
				</div>
			</aside>
		</>
	)
}

export function GlobalAIChat() {
	return <AIPanelSurface />
}

export function GlobalAIToggle() {
	const { isOpen, toggle } = useAIPanel()
	return (
		<Button
			variant={isOpen ? 'secondary' : 'outline'}
			type="button"
			onClick={toggle}
			aria-pressed={isOpen}
			aria-label={isOpen ? 'Close assistant' : 'Open assistant'}
			className="h-8 gap-1.5 rounded-lg px-2.5 text-sm font-normal"
		>
			<span className="hidden md:inline">
				<Trans>Ask AI</Trans>
			</span>
		</Button>
	)
}
