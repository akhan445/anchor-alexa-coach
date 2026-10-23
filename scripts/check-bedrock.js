// One-off check that your AWS credentials can reach both Bedrock models Anchor uses. Run: npm run check-bedrock
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const models = [
  ['agent (simulated Alexa+)', process.env.AGENT_MODEL_ID || 'us.amazon.nova-pro-v1:0'],
  ['background jobs', process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-lite-v1:0'],
];

let failed = false;
for (const [role, modelId] of models) {
  try {
    const res = await client.send(
      new ConverseCommand({ modelId, messages: [{ role: 'user', content: [{ text: 'Say hello to Anchor in five words.' }] }] })
    );
    console.log(`✅ ${role}: ${modelId} works: ${res.output.message.content[0].text}`);
  } catch (err) {
    failed = true;
    console.error(`❌ ${role}: ${modelId} failed: ${err.name}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
