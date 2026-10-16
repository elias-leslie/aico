/// <reference types="vite/client" />
// The titlebar games this build ships: their keys, names and chunk loaders.
// Small and engine-free, so the palette's "Choose game" list costs a window
// nothing until a game actually runs.

/** Game chunk loaders by file path; each game is its own chunk. */
export const games = import.meta.glob('./concepts/*.js')
export const keyOf = (path: string): string => path.replace(/^.*\/([a-z0-9]+)\.js$/, '$1')

const NAMES: Record<string, string> = {
  birds: 'Birds',
  cyberagents: 'Cyberpunk agents',
  flyingjoust: 'Flying joust',
  girderclimb: 'Girder climb',
  gothicplatformer: 'Gothic platformer',
  lightgunhunt: 'Light-gun hunt',
  loungeadventure: 'Lounge adventure',
  mazechase: 'Maze chase',
  monochromecastle: 'Monochrome castle',
  ninjaacrobat: 'Ninja acrobat',
  pirateadventure: 'Pirate adventure',
  robotplatformer: 'Robot platformer',
  runandgun: 'Run and gun',
  spaceadventure: 'Space adventure',
  suitexplorer: 'Power-suit explorer',
  swordduel: 'Sword duel',
  tankcommando: 'Tank commando',
  vectorescape: 'Vector escape',
  walkerrescue: 'Walker rescue',
}
/** Every game this build ships, for the "Choose game" picker, by name. */
export const GAMES: { key: string; name: string }[] = Object.keys(games)
  .map(keyOf)
  .map((key) => ({ key, name: NAMES[key] ?? key }))
  .sort((a, b) => a.name.localeCompare(b.name))
