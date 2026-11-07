import { TEST_ENTRY_APIS, TEST_LOGINS, TEST_PORTS } from '@aico/fleet/hub/testing'
import { expect, it } from 'vitest'
import { tetherHubPorts } from './ports'

// @aico/fleet's hub tests run on fake tools; these keep the fake ones equal to the adapters'.
it("gives the hub's tests the logins and entry APIs the tool adapters declare", () => {
  expect(tetherHubPorts.tools.logins).toEqual(TEST_LOGINS)
  expect(tetherHubPorts.tools.entryTools()).toEqual(TEST_PORTS.tools.entryTools())
  expect(tetherHubPorts.tools.signInTitle).toBe(TEST_PORTS.tools.signInTitle)
  expect(TEST_ENTRY_APIS.length).toBeGreaterThan(0)
})
