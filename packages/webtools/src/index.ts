// aico web: public web search and page fetch for agents, with a call counter on Status.

export { NOT_HANDLED, runWebCli, USAGE, type WebIo } from './cli'
export { count, counterRow, openCounter, today, webtoolsDbPath } from './counter'
export { fetchBatch, fetchPage, refocus, research, searchWeb } from './fetch'
