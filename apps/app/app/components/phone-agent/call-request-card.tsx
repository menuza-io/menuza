import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	type CallRequest,
	formatDateTime,
	formatDetailValue,
	formatPhone,
} from './call-data.ts'
import { useVerticalLabels } from './vertical-labels.ts'

export function CallRequestCard({
	request,
	pending,
	onToggleStatus,
	onOpenCall,
}: {
	request: CallRequest
	pending?: boolean
	onToggleStatus?: (request: CallRequest) => void
	onOpenCall?: (callId: string) => void
}) {
	const { _, i18n } = useLingui()
	const labels = useVerticalLabels()
	const details = Object.entries(request.details ?? {})
	const caller = [request.callerName, formatPhone(request.callerPhone)]
		.filter(Boolean)
		.join(' · ')
	return (
		<div className="flex flex-col gap-3 rounded-lg border p-4">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Badge variant="secondary">
						{labels.requestTypeLabel(request.type)}
					</Badge>
					{request.status === 'done' ? (
						<Badge variant="outline">
							<Icon name="check" />
							<Trans>Done</Trans>
						</Badge>
					) : null}
					<span className="min-w-0 truncate text-sm font-medium">
						{caller || _(msg`Unknown caller`)}
					</span>
				</div>
				<span className="text-muted-foreground text-xs tabular-nums">
					{formatDateTime(request.createdAt, i18n.locale)}
				</span>
			</div>
			{details.length ? (
				<dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
					{details.map(([key, value]) => (
						<div key={key} className="contents">
							<dt className="text-muted-foreground">{key}</dt>
							<dd className="break-words">{formatDetailValue(value)}</dd>
						</div>
					))}
				</dl>
			) : null}
			{onToggleStatus || onOpenCall ? (
				<div className="flex flex-wrap gap-2">
					{onToggleStatus ? (
						<Button
							variant={request.status === 'open' ? 'default' : 'outline'}
							size="sm"
							disabled={pending}
							onClick={() => onToggleStatus(request)}
						>
							{request.status === 'open' ? (
								<>
									<Icon name="check" />
									<Trans>Mark done</Trans>
								</>
							) : (
								<>
									<Icon name="undo-2" />
									<Trans>Reopen</Trans>
								</>
							)}
						</Button>
					) : null}
					{onOpenCall ? (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onOpenCall(request.callId)}
						>
							<Icon name="phone" />
							<Trans>View call</Trans>
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	)
}
