export { Status } from './src/status.js'
export { getUptimeStatus } from './src/betterstack-client.js'
export type {
	StatusInfo,
	StatusType,
	Monitor,
	MonitorsResponse,
} from './src/types.js'
export {
	logger,
	createChildLogger,
	sanitizeUrl,
	sanitizeIpAddress,
	getClientIp,
} from './src/logger.server.js'

// Wide Event logging exports
export {
	wideEventMiddleware,
	addUserContext,
	addErrorContext,
	type WideEventMiddlewareOptions,
} from './src/wide-event.js'
export {
	getRequestContext,
	getWideEvent,
	addWideEventContext,
	runWithRequestContext,
	generateRequestId,
	generateTraceId,
	parseTraceId,
	WideEventBuilder,
	type RequestContext,
} from './src/request-context.js'

export {
	searchLogsByTraceId,
	toLogSearchHit,
	type LogSearchConfig,
	type LogSearchHit,
	type LogSearchResult,
} from './src/log-search.js'
