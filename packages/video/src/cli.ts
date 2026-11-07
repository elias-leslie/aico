// `aico video URL [--ask Q] [--transcript] [--range A-B] [--model M] [--refresh]`.
// Exit 0 with an answer or, when Gemini is unavailable, the transcript's path (said plainly);
// 1 nothing usable (no captions and Gemini failed); 2 usage.
import { parseArgs } from 'node:util'
import { config, type Resolution } from './config'
import { type Deps, runVideo, UsageError } from './video'

const levels = Object.keys(config.gemini.mediaResolution).join(', ')
export const USAGE = `Usage: aico video URL [options]
  Reviews a YouTube video: Gemini watches it (picture and sound) with the cleaned captions attached,
  and returns what it is, key points with timestamps, what is shown on screen, the claims, and quotes.
  Files are kept per video (${config.cache.dirs[0]}/ID/): review.md, transcript.txt, meta.json.
Options:
  --ask "QUESTION"     answer one question about the video (up to 250 words) instead of the full review
  --transcript         print the cleaned captions ([mm:ss] paragraphs); no model is called
  --range A-B          only that part (mm:ss, h:mm:ss or seconds; 2:00-4:00, 2:00- or -4:00): slices the
                       transcript, and Gemini watches only that clip for a review or --ask
  --model MODEL        Gemini model for the video (default ${config.gemini.videoModel}, set in packages/video/data/video.json)
  --resolution LEVEL   how closely Gemini reads frames: ${levels} (default ${config.gemini.defaultResolution};
                       raise it for small code or slide text, at several times the tokens)
  --lang CODE          caption language to fetch (default ${config.ytdlp.defaultLang})
  --refresh            ignore the saved review, answer and captions
The first review of a video takes about 2-4 minutes, so run it in the background or with a long
timeout; a repeat is instant. Public videos only. If Gemini cannot watch the video the review comes
from the captions alone, and the output says so; with no Gemini at all you get the transcript path.
`

export async function runVideoCli(argv: string[], deps: Deps): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        ask: { type: 'string' },
        transcript: { type: 'boolean' },
        range: { type: 'string' },
        model: { type: 'string' },
        resolution: { type: 'string' },
        lang: { type: 'string' },
        refresh: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
    if (values.help || positionals[0] === 'help') {
      deps.out(USAGE)
      return 0
    }
    if (positionals.length !== 1) throw new UsageError('give one YouTube link or video id')
    if (values.resolution && !(values.resolution in config.gemini.mediaResolution))
      throw new UsageError(`--resolution is one of ${levels}`)
    return await runVideo(
      { ...values, url: positionals[0], resolution: values.resolution as Resolution | undefined },
      deps,
    )
  } catch (error) {
    const usage =
      error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    deps.err(`aico video: ${(error as Error).message}\n`)
    if (usage) deps.err(`${USAGE.split('\n')[0]}   (aico video --help for the rest)\n`)
    return usage ? 2 : 1
  }
}
