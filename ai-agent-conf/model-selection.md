# AI Model Selection — OpenRouter vs Groq

## Context

The orchestrator (`agent/orchestrator.ts`) currently uses `gemini-2.5-flash` via `@google/generative-ai`.
Task: synthesize ~3000-8000 tokens of multi-source Italian mountain data into a ~500-token guide (RAG-style).

---

## All Evaluated Models

### Groq (free tier — OpenAI-compatible at `api.groq.com`)

| Model | Quality | Speed | Limits |
|---|---|---|---|
| `llama-3.3-70b-versatile` | ⭐⭐⭐⭐ | 🚀 ~500 tok/s | 1K RPD · 100K TPD |
| `meta-llama/llama-4-scout-17b-16e-instruct` | ⭐⭐⭐⭐ | 🚀 Groq fast | 1K RPD · 500K TPD |
| `qwen/qwen3-32b` | ⭐⭐⭐⭐ | 🚀 Groq fast | 1K RPD · 500K TPD · 60 RPM |
| `groq/compound` | ⭐⭐⭐ | fast | 250 RPD only |
| `llama-3.1-8b-instant` | ⭐⭐ | 🚀 fastest | 14.4K RPD · 500K TPD |
| `allam-2-7b` | ❌ | — | Arabic-focused, wrong language |

### OpenRouter (free tier — OpenAI-compatible at `openrouter.ai`)

| Model | Quality | Context | Notes |
|---|---|---|---|
| `google/gemma-4-31b-it:free` | ⭐⭐⭐⭐ | 256K | Latest Google (Apr 2026), 140+ languages, reasoning mode |
| `qwen/qwen3-next-80b-a3b-instruct-2509:free` | ⭐⭐⭐⭐ | 262K | "Optimized for RAG and agentic workflows" |
| `meta-llama/llama-3.3-70b-instruct:free` | ⭐⭐⭐⭐ | 131K | Italian explicitly in model card |
| `nousresearch/hermes-3-llama-3.1-405b:free` | ⭐⭐⭐⭐⭐ | 131K | Highest quality but Venice provider (slow/cold starts) |
| `arcee-ai/trinity-large-preview:free` | ⭐⭐⭐⭐ | 131K | Creative writing + agentic |
| `nvidia/nemotron-3-super-120b-a12b:free` | ⭐⭐⭐⭐ | 1M | ⚠️ Logs ALL prompts to NVIDIA for training |
| `openai/gpt-oss-120b:free` | ⭐⭐⭐⭐ | unknown | Limited daily quota |
| `google/gemma-3-27b-it:free` | ⭐⭐⭐ | — | Older generation, superseded by Gemma 4 |
| Models < 10B params | ❌ | — | Too small for quality Italian synthesis |
| Embed / guard models | ❌ | — | Wrong task type entirely |

---

## Top 3 Picks

### 🥇 #1 — Groq `llama-3.3-70b-versatile` (RECOMMENDED)

**Why:** Llama 3.3 70B **explicitly supports Italian** in its model card ("Supported languages: English, German, French, **Italian**, Portuguese, Hindi, Spanish, Thai"). Running on Groq's LPU hardware gives ~500 tok/sec — a 500-token guide generates in ~1s vs 5-10s with Gemini free tier. "Genera AI Guide" becomes instant.

- Context: 128K (well above our 3-8K typical input)
- Rate limits: 1K RPD, 100K TPD — fine for personal use
- No data logging / prompt used for training

### 🥈 #2 — OpenRouter `google/gemma-4-31b-it:free`

**Why:** Gemma 4 31B is Google's newest model (April 2026), likely better than current Gemini 2.5 Flash on Italian text synthesis. 256K context, reasoning mode, Apache 2.0 license. Best fallback if Groq daily limits are hit.

### 🥉 #3 — Groq `qwen/qwen3-32b`

**Why:** 60 RPM (double other Groq models), 500K TPD, strong multilingual quality. Best second-fallback option.

---

## What to Avoid

| Model | Reason |
|---|---|
| `allam-2-7b` | Arabic-focused |
| NVIDIA Nemotron (free) | Logs all prompts to NVIDIA for product training |
| Models < 10B | Quality insufficient for multilingual synthesis |
| `groq/compound` | Only 250 RPD |
| Venice provider models | Cold starts, unpredictable latency on free tier |

---

## Implementation

### Files to change

| File | Change |
|---|---|
| `agent/orchestrator.ts` | Remove `@google/generative-ai`, add OpenAI-compatible fetch (~25 lines) |
| `.env` | Add `GROQ_API_KEY` |
| `.env.example` | Add `GROQ_API_KEY` comment |

### Get your free key

1. Go to [console.groq.com](https://console.groq.com) → API Keys → Create API Key
2. Add to `.env`: `GROQ_API_KEY=your_key_here`

### API call format (both Groq and OpenRouter are identical)

```typescript
const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage  },
    ],
  }),
});
const data = await res.json();
const description = data.choices[0].message.content;
```

### Fallback model chain

```typescript
const AI_MODELS = [
  { base: 'https://api.groq.com/openai/v1',      slug: 'llama-3.3-70b-versatile',                  key: 'GROQ_API_KEY' },
  { base: 'https://api.groq.com/openai/v1',      slug: 'qwen/qwen3-32b',                           key: 'GROQ_API_KEY' },
  { base: 'https://openrouter.ai/api/v1',        slug: 'google/gemma-4-31b-it:free',               key: 'OPENROUTER_API_KEY' },
];
```

### Verification

1. Add `GROQ_API_KEY` to `.env`
2. `npm run dev`
3. Click "Genera AI Guide" on any POI
4. Response should arrive in ~1-2s (vs 5-10s previously)
5. Check Italian text quality in the generated guide
