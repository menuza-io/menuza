import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { ScrollArea } from '@repo/ui/scroll-area'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { useEffect } from 'react'
import {
	Link,
	useFetcher,
	useLocation,
	useNavigate,
	useParams,
	useSearchParams,
} from 'react-router'
import { type loader as testCallLoader } from '#app/routes/_app+/$orgSlug_+/phone-agent+/test-call.ts'
import { TestCallPanel } from './test-call-panel.tsx'

/** Search param that opens the test call sheet: `1`, `draft`, or `published`. */
export const TEST_CALL_PARAM = 'test'

/** The current URL with the test call sheet open. */
export function useTestCallHref(flow?: 'draft' | 'published') {
	const location = useLocation()
	const params = new URLSearchParams(location.search)
	params.set(TEST_CALL_PARAM, flow ?? '1')
	return `${location.pathname}?${params.toString()}`
}

export function TestCallButton({
	variant = 'outline',
}: {
	variant?: 'outline' | 'default'
}) {
	const href = useTestCallHref()
	return (
		<Button variant={variant} render={<Link to={href} preventScrollReset />}>
			<Icon name="mic" />
			<Trans>Test call</Trans>
		</Button>
	)
}

/**
 * Talk to the agent from the browser without leaving the page. Opens while
 * the URL has `?test=`, so any page or the call flow editor can link to it.
 */
export function TestCallSheet({
	regionSupported,
}: {
	regionSupported: boolean
}) {
	const { orgSlug = '' } = useParams()
	const [searchParams] = useSearchParams()
	const location = useLocation()
	const navigate = useNavigate()
	const requested = searchParams.get(TEST_CALL_PARAM)
	const open = requested !== null
	const flow =
		requested === 'draft' || requested === 'published' ? requested : null
	const fetcher = useFetcher<typeof testCallLoader>()
	const loadHref = `/${orgSlug}/phone-agent/test-call${flow ? `?flow=${flow}` : ''}`

	const { load } = fetcher
	useEffect(() => {
		if (open) void load(loadHref)
	}, [open, loadHref, load])

	function close() {
		const next = new URLSearchParams(location.search)
		next.delete(TEST_CALL_PARAM)
		const search = next.toString()
		void navigate(
			{ pathname: location.pathname, search: search ? `?${search}` : '' },
			{ replace: true, preventScrollReset: true },
		)
	}

	const data = fetcher.data
	return (
		<Sheet
			open={open}
			onOpenChange={(next) => {
				if (!next) close()
			}}
		>
			<SheetContent className="w-full sm:max-w-lg">
				<SheetHeader>
					<SheetTitle>
						<Trans>Test call</Trans>
					</SheetTitle>
					<SheetDescription>
						<Trans>
							Talk to your agent from this browser and use the dial pad to press
							keys. Test calls use the same call flow, rules, and business
							details as real calls and appear in Calls marked as tests.
						</Trans>
					</SheetDescription>
				</SheetHeader>
				<ScrollArea className="min-h-0 flex-1">
					<div className="flex flex-col gap-6 px-4 pb-6">
						{!data ? (
							<p role="status" className="text-muted-foreground text-sm">
								<Trans>Loading…</Trans>
							</p>
						) : data.liveKitConfigured ? (
							<TestCallPanel
								key={`${flow ?? ''}:${data.defaultFlow}`}
								orgSlug={orgSlug}
								scopes={data.scopes}
								hasPublishedFlow={data.hasPublishedFlow}
								defaultFlow={data.defaultFlow}
								canStart={data.canStart}
								agentName={data.agentName}
								agentNumbers={data.agentNumbers}
								regionSupported={regionSupported}
							/>
						) : (
							<div className="rounded-lg border border-dashed py-6">
								<Empty>
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<Icon name="phone-off" />
										</EmptyMedia>
										<EmptyTitle>
											<Trans>Test calls aren't available yet</Trans>
										</EmptyTitle>
										<EmptyDescription>
											<Trans>
												The voice service for your account hasn't been set up.
												Contact support and we'll turn it on.
											</Trans>
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							</div>
						)}
					</div>
				</ScrollArea>
			</SheetContent>
		</Sheet>
	)
}
