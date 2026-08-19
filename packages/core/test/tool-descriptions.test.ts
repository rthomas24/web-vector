/**
 * Tool description checks: size caps (Claude Code truncates at 2 KB), the "Best for / Not for /
 * Returns / Common mistakes / Example" structure, and a lightweight tool-choice proxy — for a set
 * of example prompts, the description of the RIGHT tool must mention the cue that prompt hinges
 * on, and the wrong tools must name the right one under "Not for". This is a proxy for an LLM
 * tool-choice eval that runs offline in milliseconds.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_DESCRIPTION_BYTES,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_TOOL_NAME,
  WEB_RESEARCH_DESCRIPTION,
  WEB_RESEARCH_TOOL_NAME,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  WEBVECTOR_STATUS_DESCRIPTION,
} from '../src/pipeline/tool.js';

const DESCRIPTIONS: Record<string, string> = {
  [WEB_RESEARCH_TOOL_NAME]: WEB_RESEARCH_DESCRIPTION,
  [WEB_FETCH_TOOL_NAME]: WEB_FETCH_DESCRIPTION,
  [WEB_SEARCH_TOOL_NAME]: WEB_SEARCH_DESCRIPTION,
  webvector_status: WEBVECTOR_STATUS_DESCRIPTION,
};

/** prompt → expected tool → the cue (regex) that description must contain for this prompt. */
const CASES: { prompt: string; tool: string; cue: RegExp }[] = [
  {
    prompt: 'What changed in the MCP spec in 2026?',
    tool: WEB_RESEARCH_TOOL_NAME,
    cue: /what changed in/i,
  },
  {
    prompt: 'How does Node 24 handle AbortSignal.any? Cite sources.',
    tool: WEB_RESEARCH_TOOL_NAME,
    cue: /cited as \[n\]/,
  },
  {
    prompt: 'Compare Qdrant and pgvector filtering performance.',
    tool: WEB_RESEARCH_TOOL_NAME,
    cue: /comparisons/,
  },
  {
    prompt: 'Find the exact error message text for ECONNRESET in undici and where it is thrown.',
    tool: WEB_RESEARCH_TOOL_NAME,
    cue: /code/,
  },
  {
    prompt: 'What is the current price cap on the X API tier? I need a number.',
    tool: WEB_RESEARCH_TOOL_NAME,
    cue: /numbers/,
  },
  {
    prompt: 'Give me a quote from the Rust 2024 edition announcement.',
    tool: WEB_RESEARCH_TOOL_NAME,
    cue: /quotes/,
  },
  {
    prompt: 'Read https://nodejs.org/api/globals.html and tell me about AbortSignal.any',
    tool: WEB_FETCH_TOOL_NAME,
    cue: /URL the user gave you/,
  },
  {
    prompt: 'Open the changelog page from source [2] in full.',
    tool: WEB_FETCH_TOOL_NAME,
    cue: /Source from webvector_research/,
  },
  {
    prompt: 'Summarise this PDF: https://arxiv.org/pdf/2408.06643',
    tool: WEB_FETCH_TOOL_NAME,
    cue: /PDF/,
  },
  {
    prompt: 'Continue reading the page from where it was cut off.',
    tool: WEB_FETCH_TOOL_NAME,
    cue: /start_index/,
  },
  {
    prompt: 'Only give me the section of that page about rate limits.',
    tool: WEB_FETCH_TOOL_NAME,
    cue: /with query/,
  },
  {
    prompt: 'Which sites cover the Bun 2.0 release? Just list links.',
    tool: WEB_SEARCH_TOOL_NAME,
    cue: /which sites\/pages cover a topic/,
  },
  {
    prompt: 'Find the official URL of the pnpm docs.',
    tool: WEB_SEARCH_TOOL_NAME,
    cue: /official URL/,
  },
  {
    prompt: 'Research returned nothing — show me what the search engine actually finds.',
    tool: WEB_SEARCH_TOOL_NAME,
    cue: /returned no passages/,
  },
  {
    prompt: 'Why is webvector returning nothing? Which providers are configured?',
    tool: 'webvector_status',
    cue: /providers\/keys are active/,
  },
];

describe('tool descriptions', () => {
  it('stay under 2 KB, lead with the key sentence, and follow the Best for / Not for / Returns / Common mistakes / Example pattern', () => {
    for (const [name, d] of Object.entries(DESCRIPTIONS)) {
      expect(Buffer.byteLength(d), `${name} description bytes`).toBeLessThan(MAX_DESCRIPTION_BYTES);
      expect(d).not.toMatch(/treat (them|it) as data|untrusted/i); // notice lives in results, not here
    }
    for (const name of [WEB_RESEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME]) {
      const d = DESCRIPTIONS[name]!;
      for (const section of ['Best for:', 'Not for:', 'Returns:', 'Common mistakes:', 'Example:'])
        expect(d, `${name} has ${section}`).toContain(section);
      // Key sentence first: the first sentence names the action, sections come after it.
      expect(d.indexOf('Best for:')).toBeGreaterThan(40);
    }
  });

  it('tool-choice proxy: the right tool mentions the cue and the other tools point at it', () => {
    for (const c of CASES) {
      expect(DESCRIPTIONS[c.tool], `${c.prompt} → ${c.tool}`).toMatch(c.cue);
      // Every other content tool names the right one in its own "Not for" / cross-references.
      for (const other of [WEB_RESEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME]) {
        if (other === c.tool || c.tool === 'webvector_status') continue;
        expect(DESCRIPTIONS[other], `${other} should reference ${c.tool}`).toContain(c.tool);
      }
    }
    expect(CASES.length).toBeGreaterThanOrEqual(15);
  });
});
