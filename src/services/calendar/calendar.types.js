/**
 * @typedef {'financials'|'tax'|'marketing'|'investments'|'ops'} ModuleKey
 * @typedef {'job'|'lead'|'post'|'email'|'invoice'|'deadline'|'meeting'|'task'} EventType
 * @typedef {'manual'|'gcal'|'applecal'|'ics'|'qbo'|'servicetitan'|'jobber'|'marketing'} EventSource
 * @typedef {'scheduled'|'in_progress'|'done'|'canceled'} EventStatus
 * @typedef {'high'|'medium'|'low'} Severity
 *
 * @typedef {Object} Attendee
 * @property {string} name
 * @property {string} [email]
 * @property {'internal'|'customer'|'vendor'} [role]
 * @property {boolean} [required]
 * @property {'yes'|'no'|'maybe'|'none'} [rsvp]
 *
 * @typedef {Object} Reminder
 * @property {string} offset_str   // '-7d', '-2h', '-30m'
 * @property {'inapp'|'email'|'sms'} [channel]
 *
 * @typedef {Object} CalendarEvent
 * @property {string} id
 * @property {string} business_id
 * @property {string} user_id
 * @property {ModuleKey} module
 * @property {EventType} type
 * @property {string} title
 * @property {string} [description]
 * @property {string} start     // ISO
 * @property {string} end       // ISO
 * @property {boolean} all_day
 * @property {string} [location]
 * @property {Attendee[]} [attendees]
 * @property {EventSource} source
 * @property {EventStatus} status
 * @property {{job_id?:string,lead_id?:string,invoice_id?:string,post_id?:string}} [links]
 * @property {Reminder[]} [reminders]
 * @property {string} [color]
 * @property {string} created_at
 * @property {string} updated_at
 */
