import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { agentTask, generateListing } from '@/cli/lib/listing.mjs';

const image = path.resolve(__dirname, '../fixtures/agentic-control/sample-design.png');

// Deterministic stand-in for a subscription CLI: answers each core prompt with
// the JSON its parser expects, and records which calls carried the image.
function fakeEngine() {
  const calls: Array<{ engine: string; hasImage: boolean; prompt: string }> = [];
  const run = async ({ engine, prompt, imageBase64 }: { engine: string; prompt: string; imageBase64?: string }) => {
    calls.push({ engine, hasImage: !!imageBase64, prompt });
    if (imageBase64) {
      return JSON.stringify({ visualElements: ['cat'], detectedText: ['Cat Dad'], style: 'cartoon', mood: 'funny', colors: ['orange'] });
    }
    if (prompt.includes('generate keyword candidates')) {
      return JSON.stringify({ visual: ['cat'], text: ['cat dad'], who: ['cat dad'], what: ['funny cat'], why: [], when: [], where: [], lsi: [] });
    }
    if (prompt.includes('Generate an Amazon Merch listing')) {
      return JSON.stringify({ title: 'Cat Dad', brand: 'Whiskers Co', 'bullet-1': 'Funny cat dad art', 'bullet-2': 'Cute feline graphic' });
    }
    throw new Error(`unhandled prompt: ${prompt.slice(0, 60)}`);
  };
  return { calls, run };
}

describe('iscale listing generate', () => {
  it('runs the shared pipeline through the ChatGPT-plan engine and shared settings', async () => {
    const { calls, run } = fakeEngine();
    const r = await generateListing({ imagePath: image, settings: null, engine: 'codex', trademark: false, validate: false, run });
    expect(r.fields.find((f: { id: string }) => f.id === 'title')?.content).toBe('Cat Dad');
    expect(r.trademark.status).toBe('skipped');
    expect(calls.every((c) => c.engine === 'codex')).toBe(true);
    expect(calls[0].hasImage).toBe(true);
  });

  it('agent mode without shared settings still gives the agent real fields and limits', async () => {
    const task = await agentTask({ imagePath: image, settings: null });
    expect(task.fields.length).toBeGreaterThan(0);
    expect(task.fields.every((f: { maxChars: number }) => f.maxChars > 0)).toBe(true);
  });

  it('agent mode hands the calling agent the user\'s prompt rules, fields and classes', async () => {
    const task = await agentTask({
      imagePath: image,
      settings: {
        config: {
          customInstructions: 'Always mention the niche',
          fields: [{ id: 'title', name: 'Title', maxChars: 60 }],
          forbiddenWords: ['shirt'],
          trademarkClasses: ['025', '021'],
        },
      },
    });
    expect(task).toMatchObject({
      status: 'awaiting_agent',
      instructions: 'Always mention the niche',
      forbiddenWords: ['shirt'],
      trademarkClasses: ['025', '021'],
    });
  });
});
