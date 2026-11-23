import {
	TRACE_ID_GLOBAL,
	TraceIdProvider,
	generateTraceId,
	installTraceIdFetch,
	parseTraceId,
} from '@repo/common/trace-id'
import { i18n, I18nProvider, detect, fromHtmlTag } from '@repo/i18n'
import { startTransition } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { HydratedRouter } from 'react-router/dom'
import { loadCatalog } from './modules/lingui/lingui'

// The page-load trace id (#385): the server wrote it into the document; it
// rides on every same-origin request from here on.
const traceId =
	parseTraceId(
		(window as unknown as Record<string, unknown>)[TRACE_ID_GLOBAL],
	) ?? generateTraceId()
installTraceIdFetch(traceId)

const locale = detect(fromHtmlTag('lang')) || 'en'
await loadCatalog(locale)

startTransition(() => {
	hydrateRoot(
		document,
		<I18nProvider i18n={i18n}>
			<TraceIdProvider value={traceId}>
				<HydratedRouter />
			</TraceIdProvider>
		</I18nProvider>,
	)
})
