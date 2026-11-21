import 'varlock/auto-load'

// Suites that are not about quiet hours (#75) send marketing texts at any
// clock; the quiet-hours suites turn this back on. Honoured only under
// NODE_ENV=test.
process.env.MARKETING_SMS_QUIET_HOURS ??= 'off'
