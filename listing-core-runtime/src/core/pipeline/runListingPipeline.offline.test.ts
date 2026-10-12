// High-fidelity offline integration test. Unlike runListingPipeline.test.ts
// (which mocks the step MODULES to assert orchestration), this runs the REAL
// analyzeImage / generateCandidates / generateListing through the pipeline with
// only the AI transport injected — proving the genuine generation path works with
// no network. This is what makes CLI listing generation testable in CI.

import { describe, it, expect } from 'vitest';
import { runListingPipeline } from './runListingPipeline';
import { DEFAULT_LISTING_CONFIG } from '../types';
import type { AIConfig, AITransport } from '@/lib/ai-provider';

// A scripted, deterministic stand-in for a real provider. `chat`/`vision` replace
// the network dispatch (via AIConfig.transport); each returns the JSON the real
// step parsers expect, routed by a stable phrase in each step's prompt.
const transport: AITransport = {
  vision: async () =>
    JSON.stringify({
      visualElements: ['cat'],
      detectedText: ['Cat Dad'],
      style: 'cartoon',
      mood: 'funny',
      colors: ['orange'],
    }),
  chat: async (_config, prompt) => {
    if (prompt.includes('generate keyword candidates')) {
      return JSON.stringify({
        visual: ['cat'],
        text: ['cat dad'],
        who: ['cat dad'],
        what: ['funny cat'],
        why: [],
        when: [],
        where: [],
        lsi: [],
      });
    }
    if (prompt.includes('Generate an Amazon Merch listing')) {
      return JSON.stringify({
        title: 'Cat Dad',
        brand: 'Whiskers Co',
        'bullet-1': 'Funny cat dad art for cat lovers',
        'bullet-2': 'Cute feline graphic for proud cat dads',
      });
    }
    throw new Error(`offline transport: unhandled prompt "${prompt.slice(0, 60)}…"`);
  },
};

describe('runListingPipeline (offline, real steps)', () => {
  it('uses one vision request and no candidate chat for valid combined output', async () => {
    let visionCalls = 0;
    let candidateCalls = 0;
    const combined: AITransport = {
      vision: async () => {
        visionCalls++;
        return JSON.stringify({ analysis: JSON.parse(await transport.vision({ provider: 'openai' } as AIConfig, '', '')), candidates: { visual: ['cat'], text: ['cat dad'], who: [], what: [], why: [], when: [], where: [], lsi: [] } });
      },
      chat: async (config, prompt, ...rest) => {
        if (prompt.includes('generate keyword candidates')) candidateCalls++;
        return transport.chat(config, prompt, ...rest);
      },
    };
    const result = await runListingPipeline({ imageBase64: 'x', aiConfig: { provider: 'openai', apiKey: '', transport: combined }, config: DEFAULT_LISTING_CONFIG, validateEnabled: false, trademarkEnabled: false }, { autosuggest: null });
    expect(visionCalls).toBe(1);
    expect(candidateCalls).toBe(0);
    expect(result.validated.map(row => row.word)).toContain('cat dad');
    expect(result.analysis.rawResponse).not.toContain('candidates');
  });
  it('generates a listing end-to-end with no network via an injected transport', async () => {
    const aiConfig: AIConfig = { provider: 'openai', apiKey: '', transport };

    const result = await runListingPipeline(
      {
        imageBase64: 'data:image/png;base64,xxx',
        aiConfig,
        config: DEFAULT_LISTING_CONFIG,
        validateEnabled: false, // no Amazon autosuggest
        trademarkEnabled: false, // no trademark API call
      },
      { autosuggest: null }
    );

    // Real analyzeImage parsed the scripted vision JSON.
    expect(result.analysis.detectedText).toContain('Cat Dad');
    // Real generateCandidates + passthrough + autoSelect produced keywords.
    expect(result.validated.map((k) => k.word)).toContain('cat dad');
    // Real generateListing parsed + sanitized the scripted listing JSON.
    const title = result.listing.fields.find((f) => f.fieldId === 'title');
    expect(title?.content.toLowerCase()).toContain('cat dad');
    expect(title!.content.length).toBeLessThanOrEqual(title!.maxChars);
    expect(result.trademark).toBeNull();
    expect(result.trademarkError).toBeNull();
  });

  it('uses a known design description (sidecar) without sending the image to the AI', async () => {
    let visionCalls = 0;
    let candidatePrompt = '';
    const counting: AITransport = {
      vision: async (...args) => {
        visionCalls += 1;
        return transport.vision(...args);
      },
      chat: async (config, prompt) => {
        if (prompt.includes('generate keyword candidates')) candidatePrompt = prompt;
        return transport.chat(config, prompt);
      },
    };
    const result = await runListingPipeline(
      {
        imageBase64: '',
        analysis: {
          visualElements: ['grumpy cat', 'coffee cup'],
          detectedText: ['Cat Dad'],
          style: 'cartoon',
          mood: 'funny',
          colors: ['orange'],
          scene: 'A grumpy cat holding a coffee cup',
          rawResponse: '',
        },
        aiConfig: { provider: 'openai', apiKey: '', transport: counting },
        config: DEFAULT_LISTING_CONFIG,
        validateEnabled: false,
        trademarkEnabled: false,
      },
      { autosuggest: null }
    );
    expect(visionCalls).toBe(0);
    expect(candidatePrompt).toContain('grumpy cat');
    expect(candidatePrompt).toContain('A grumpy cat holding a coffee cup');
    expect(result.analysis.detectedText).toEqual(['Cat Dad']);
    expect(result.listing.fields.find((f) => f.fieldId === 'title')?.content.toLowerCase()).toContain('cat dad');
  });
});
