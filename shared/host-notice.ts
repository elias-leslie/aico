// What a window shows while its session's host cannot be reached, worded the
// same on the desktop and the web app. `live` (or an unknown state) shows
// nothing: the terminal is in use.

type Notice = Omit<HostNoticeCopy, 'powerOn'> & { powerOn?: boolean }

export interface HostNoticeCopy {
  title: string
  detail: string
  /** Offer Reconnect (try again now). */
  reconnect: boolean
  /** Offer Power on instead (the host is off; Reconnect can't help). */
  powerOn: boolean
}

export function hostNoticeCopy(host: string, state: string): HostNoticeCopy | null {
  const copy = noticeFor(host, state)
  return copy ? { ...copy, powerOn: copy.powerOn ?? false } : null
}

function noticeFor(host: string, state: string): Notice | null {
  switch (state) {
    case 'connecting':
      return {
        title: `Connecting to ${host}…`,
        detail: 'The session keeps running there.',
        reconnect: false,
      }
    case 'offline':
      return {
        title: `${host} is offline`,
        detail: `The session stays on ${host}. Aico reconnects when the host is back.`,
        reconnect: true,
      }
    case 'powered_off':
      return {
        title: `${host} is powered off`,
        detail: 'Power it on to get back to this session.',
        reconnect: false,
        powerOn: true,
      }
    case 'identity_changed':
      return {
        title: `${host} is not the same machine`,
        detail: 'Aico does not connect until the host is checked.',
        reconnect: false,
      }
    case 'disconnected':
      return {
        title: `Disconnected from ${host}`,
        detail: 'Aico tries again when the link to the host comes back.',
        reconnect: true,
      }
    case 'refused':
      return {
        title: `${host} has no room for another session`,
        detail: `Too many sessions are open on ${host}. Close one, then Reconnect.`,
        reconnect: true,
      }
    default:
      return null
  }
}
