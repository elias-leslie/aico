import { expect, it } from 'vitest'
import { accessOf, planAccess } from './LoginAccess'

const known = ['coordinator', 'review', 'implementation']
it('ticks every known role except the blocked ones when all roles are on', () => {
  expect(
    accessOf({ machines: ['a'], roles: ['*'], deniedRoles: ['review'] }, known),
  ).toEqual({
    machines: ['a'],
    all: true,
    roles: ['coordinator', 'implementation'],
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
    { machines: [], all: true, roles: ['coordinator', 'implementation'] },
    known,
  )
  expect(blocked).toEqual([{ type: 'role', value: 'review', granted: false }])
  expect(
    planAccess(
      { ...grants, deniedRoles: ['review'] },
      { machines: [], all: true, roles: known },
      known,
    ),
  ).toEqual([{ type: 'role', value: 'review', granted: true }])
})
it('turning all roles off keeps the ticked roles as explicit grants', () => {
  expect(
    planAccess(
      { machines: ['a'], roles: ['*'] },
      { machines: ['b'], all: false, roles: ['review'] },
      known,
    ),
  ).toEqual([
    { type: 'machine', value: 'a', granted: false },
    { type: 'machine', value: 'b', granted: true },
    { type: 'role', value: '*', granted: false },
    { type: 'role', value: 'review', granted: true },
  ])
})
