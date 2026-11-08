/** How one tool signs in and out on a host. `signIn` and a `session` sign-out are shell
 * lines typed into a new session there; `command` runs over ssh. The tool adapters
 * (session-engine) declare one per tool; the fleet hub reads them. */
export interface ToolLogin {
  signIn: string | null
  signOut:
    | { kind: 'revoke' }
    | { kind: 'command'; line: string }
    | { kind: 'session'; line: string }
    | null
  /** A served tool: sign-in grants it to the host first (push needs the grant). */
  grant?: boolean
  /** The tool's command and its own login file (home-relative), for a host
   * without a sign-in service: Aico checks the file is there instead. */
  local?: { bin: string; authFile: string }
  /** The sign-in screen prints a URL to open in a browser: its host. Aico then
   * shows the URL as one clean link (session-engine lifecycle/tui/sign-in-link.ts). */
  signInLink?: { host: string }
}
