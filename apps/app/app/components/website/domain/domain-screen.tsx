import { Trans } from '@lingui/macro'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { type DomainOverview } from '#app/utils/domains/overview.server.ts'
import { BuyCard } from './buy-card.tsx'
import { ConnectCard } from './connect-card.tsx'
import {
	ManagedDomainCards,
	UnmanagedForwardingNote,
} from './managed-domain-card.tsx'
import { SiteDomainsCard } from './site-domains-card.tsx'

/**
 * Website, Domain: the one screen for everything about the domains of the
 * site (#139, #313, #283, #183, #276).
 */
export function DomainScreen({
	organization,
	canUpdate,
	justConnected,
	overview,
}: {
	organization: {
		id: string
		name: string
		slug: string
		sitePublished: boolean
	}
	canUpdate: boolean
	justConnected: boolean
	overview: DomainOverview
}) {
	const hasPrimary = overview.siteDomains.some(
		(domain) => domain.isPrimary && domain.status !== 'expired',
	)
	return (
		<AnnotatedLayout className="max-w-4xl">
			<AnnotatedSection>
				<SiteDomainsCard
					siteDomains={overview.siteDomains}
					canUpdate={canUpdate}
					justConnected={justConnected}
				/>
			</AnnotatedSection>
			<AnnotatedSection>
				<ConnectCard
					hasPrimary={hasPrimary}
					cnameTarget={overview.cnameTarget}
					apexIps={overview.apexIps}
					canUpdate={canUpdate}
				/>
			</AnnotatedSection>
			<AnnotatedSection>
				<BuyCard
					registrar={overview.registrar}
					jobs={overview.jobs}
					canUpdate={canUpdate}
				/>
			</AnnotatedSection>
			<ManagedDomainCards managed={overview.managed} canUpdate={canUpdate} />
			<AnnotatedSection>
				<UnmanagedForwardingNote domains={overview.unmanaged} />
			</AnnotatedSection>
			{!canUpdate ? (
				<p className="text-muted-foreground text-sm">
					<Trans>
						You can see the domain setup. Changing it needs permission to edit
						settings.
					</Trans>
				</p>
			) : null}
			{organization.sitePublished ? null : (
				<p className="text-muted-foreground text-sm">
					<Trans>
						Your site is not published yet. Connecting a domain publishes it.
					</Trans>
				</p>
			)}
		</AnnotatedLayout>
	)
}
