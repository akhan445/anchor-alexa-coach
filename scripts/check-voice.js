// One-off check that Amazon Polly works with your AWS key. Run: npm run check-voice
import { mkdirSync, writeFileSync } from 'node:fs';
import { synthesize } from '../src/voice.js';

try {
  const mp3 = await synthesize("Hi, I'm Alexa, and I'm running your Anchor coach.");
  mkdirSync('data', { recursive: true });
  writeFileSync('data/voice-test.mp3', mp3);
  console.log(`✅ Polly works (${mp3.length} bytes). Listen: open data/voice-test.mp3`);
} catch (err) {
  console.error(`❌ Polly failed: ${err.name}: ${err.message}`);
  process.exit(1);
}
