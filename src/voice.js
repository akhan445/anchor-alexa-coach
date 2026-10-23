// Alexa's voice for the simulator: Amazon Polly turns each reply into speech.
// Uses Polly's "neural" engine: it starts fast enough for a conversation ("generative" sounds a bit nicer but is slower).
// Set POLLY_ENGINE=generative to try it; it falls back to neural if the voice or region doesn't offer it.
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

const polly = new PollyClient({ region: process.env.AWS_REGION || 'us-east-1' });
const VOICE = process.env.POLLY_VOICE || 'Danielle';
let engines = process.env.POLLY_ENGINE === 'generative' ? ['generative', 'neural'] : ['neural'];

export async function synthesize(text) {
  for (const engine of [...engines]) {
    try {
      const res = await polly.send(
        new SynthesizeSpeechCommand({ Text: text.slice(0, 2900), VoiceId: VOICE, Engine: engine, OutputFormat: 'mp3' })
      );
      return Buffer.from(await res.AudioStream.transformToByteArray());
    } catch (err) {
      // Permission problems won't be fixed by another engine, so stop there.
      if (/AccessDenied|UnrecognizedClient|security token|credentials/i.test(`${err.name} ${err.message}`)) throw err;
      console.warn(`[polly] ${engine} failed (${err.name}); trying the next engine`);
      if (engines.length > 1) engines = engines.filter(e => e !== engine); // don't retry it on every reply
    }
  }
  throw new Error('No Polly engine worked for this voice');
}
