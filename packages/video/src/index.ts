// aico video: review a YouTube video, or answer a question about it, from Gemini plus its captions.

export { parseVtt, renderTranscript } from './captions'
export { runVideoCli, USAGE } from './cli'
export { GeminiError, generate, type Post, silenceBound } from './gemini'
export { runVideo } from './video'
