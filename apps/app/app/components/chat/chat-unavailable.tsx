import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { Link } from 'react-router'

export function ChatUnavailable({
	orgSlug,
	canManageChannels,
}: {
	orgSlug: string
	canManageChannels: boolean
}) {
	return (
		<Empty className="flex-1">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Icon name="message-square" />
				</EmptyMedia>
				<EmptyTitle>
					<Trans>Team chat isn't running in this environment</Trans>
				</EmptyTitle>
				<EmptyDescription className="max-w-md">
					<Trans>
						Chat needs the Cloudflare Workers dev server (the default{' '}
						<code className="text-foreground">npm run dev</code> app, not{' '}
						<code className="text-foreground">dev:node</code>). After pulling
						migrations, run local D1 migrate for the app if channels never
						appear.
					</Trans>
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<div className="flex flex-col items-stretch gap-2 sm:flex-row sm:justify-center">
					{canManageChannels ? (
						<Button
							variant="default"
							render={
								<Link to={`/${orgSlug}/settings/chat`}>
									<Icon name="settings" />
									<Trans>Chat settings</Trans>
								</Link>
							}
						/>
					) : null}
					<Button
						type="button"
						variant="outline"
						onClick={() => window.location.reload()}
					>
						<Trans>Reload page</Trans>
					</Button>
				</div>
			</EmptyContent>
		</Empty>
	)
}
