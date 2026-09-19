import { Trans } from '@lingui/macro'
import { Link } from 'react-router'

export function MenuCatalogGate({
	title,
	description,
	websiteHref,
}: {
	title: string
	description: string
	websiteHref: string
}) {
	return (
		<div className="rounded-lg border border-dashed p-8 text-center">
			<p className="font-medium">{title}</p>
			<p className="text-muted-foreground mt-2 text-sm">{description}</p>
			<p className="mt-4">
				<Link to={websiteHref} className="text-primary text-sm font-medium">
					<Trans>Go to website settings</Trans>
				</Link>
			</p>
		</div>
	)
}
