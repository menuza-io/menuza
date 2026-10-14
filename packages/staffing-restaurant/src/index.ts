/**
 * Restaurant layer on top of the generic Staff module. The generic core
 * (`@repo/staffing`) works in opaque scopes; for restaurants a scope is an
 * organization location. Anything that names locations lives here.
 */
export * from './location-scope.ts'
