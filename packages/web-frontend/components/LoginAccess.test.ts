import { expect, it } from 'vitest'
import { accessOf, planAccess, planSessions } from './LoginAccess'

const known = ['coordinator', 'review', 'implementation']
it('ticks every known role except the blocked ones when all roles are on', () => {
  expect(
    accessOf({ machines: ['a'], roles: ['*'], deniedRoles: ['review'] }, known),
  ).toEqual({
    machines: ['a'],
    all: true,
    roles: ['coordinator', 'implementation'],
    named: [],
    sessions: [],
  })
})
it('plans nothing when nothing changed', () => {
  const grants = { machines: ['a'], roles: ['*'], deniedRoles: ['review'] }
  expect(planAccess(grants, accessOf(grants, known), known)).toEqual([])
})
it('blocks a role under all roles and allows it again', () => {
  const grants = { machines: [], roles: ['*'] }
  const blocked = planAccess(
    grants,
    {
      machines: [],
      all: true,
      roles: ['coordinator', 'implementation'],
      named: [],
      sessions: [],
    },
    known,
  )
  expect(blocked).toEqual([{ type: 'role', value: 'review', granted: false }])
  expect(
    planAccess(
      { ...grants, deniedRoles: ['review'] },
      {
        machines: [],
        all: true,
        roles: known,
        named: ['review'],
        sessions: [],
      },
      known,
    ),
  ).toEqual([{ type: 'role', value: 'review', granted: true }])
})
it('turning all roles off keeps the ticked roles as explicit grants', () => {
  expect(
    planAccess(
      { machines: ['a'], roles: ['*'] },
      {
        machines: ['b'],
        all: false,
        roles: ['review'],
        named: ['review'],
        sessions: [],
      },
      known,
    ),
  ).toEqual([
    { type: 'machine', value: 'a', granted: false },
    { type: 'machine', value: 'b', granted: true },
    { type: 'role', value: '*', granted: false },
    { type: 'role', value: 'review', granted: true },
  ])
})
it('keeps a named role next to all roles when copying a login that has one', () => {
  const source = { machines: ['a'], roles: ['*', 'school-check'] },
    target = { machines: ['a'], roles: ['*'] },
    all = [...known, 'school-check']
  expect(planAccess(target, accessOf(source, all), all)).toEqual([
    { type: 'role', value: 'school-check', granted: true },
  ])
})
it('turns a named role back into a plain all-roles one when the copied login does not name it', () => {
  const source = { machines: [], roles: ['*'] },
    target = { machines: [], roles: ['*', 'school-check'] },
    all = [...known, 'school-check']
  expect(planAccess(target, accessOf(source, all), all)).toEqual([
    { type: 'role', value: '*', granted: false },
    { type: 'role', value: 'school-check', granted: false },
    { type: 'role', value: '*', granted: true },
  ])
})
it('assigns a lab target to the sessions ticked and takes it from the ones unticked', () => {
  const choices = {
    sessions: [
      { id: 's1', label: 'One' },
      { id: 's2', label: 'Two' },
      { id: 's3', label: 'Three' },
    ],
    assignments: { s1: ['focus-pcsb'], s2: ['other', 'canvas-pcsb'] },
  } as unknown as Parameters<typeof planSessions>[0]
  expect(planSessions(choices, 'canvas-pcsb', ['s1', 'x'])).toEqual([
    {
      session: 's1',
      label: 'One',
      granted: true,
      targets: ['focus-pcsb', 'canvas-pcsb'],
    },
    { session: 's2', label: 'Two', granted: false, targets: ['other'] },
  ])
})
