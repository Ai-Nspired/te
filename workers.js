// worker.js
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

import { DurableObject } from "cloudflare:workers";

// CORS Headers
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

// Define models
const MODEL_LIST = [
  { key: 'WORKERS_AI', model: '@cf/meta/llama-3-8b-instruct', requiresChallenge: false },
  { key: 'dolphin-mistral-24b-venice-edition', model: 'cognitivecomputations/dolphin-24b', requiresChallenge: false },
  { key: 'mistral-nemo', model: 'mistralai/mistral-nemo', requiresChallenge: false, paid: true },
  // Add more models as needed
];

var MODELS = {};
MODEL_LIST.forEach(model => {
  MODELS[model.key] = {
    model: model.model,
    requiresChallenge: model.requiresChallenge,
    challengeQuestion: model.challengeQuestion,
    paid: model.paid
  };
});

var TruthEngine = class {
  static {
    __name(this, "TruthEngine");
  }

  async fetch(request, env) {
    console.log(`\n--- New Request: ${request.method} ${request.url} ---`);
    console.log(`[DEBUG] Bindings: ${Object.keys(env).join(', ')}`);

    if (!env.memy) console.error("[DEBUG] CRITICAL: 'memy' KV missing!");
    if (!env.HISTORY && !env.Chat) console.error("[DEBUG] CRITICAL: No DO binding (HISTORY or Chat)!");
    if (!env.AI) console.error("[DEBUG] CRITICAL: 'AI' binding missing!");
    if (!env.OPENROUTER_API_KEY) console.error("[DEBUG] CRITICAL: 'OPENROUTER_API_KEY' missing!");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const doBinding = env.HISTORY || env.Chat; // Support both DO names
    const historyStub = doBinding ? doBinding.get(doBinding.idFromName('truthengine-history')) : null;

    if (path.startsWith('/conversation/')) {
      return this.handleConversationRequest(request, env, historyStub);
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: CORS_HEADERS
      });
    }

    try {
      const requestBody = await request.json();
      const input = requestBody.input;

      if (typeof input !== 'string' || input.trim() === '') {
        console.error("[DEBUG] Error: Invalid or empty 'input'");
        return new Response(JSON.stringify({ error: "Invalid or empty 'input'" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      let modelKey = requestBody.model || 'mistral-nemo';
      if (!MODELS[modelKey]) {
        console.error(`[DEBUG] Invalid model key: ${modelKey}. Using mistral-nemo`);
        modelKey = 'mistral-nemo';
      }

      const normalizedQuery = this.normalizeQuery(input);
      const cacheKey = `truth:${normalizedQuery}`;
      console.log(`[DEBUG] Query: "${input}"`);
      console.log(`[DEBUG] Normalized: "${normalizedQuery}"`);
      console.log(`[DEBUG] Model: "${modelKey}"`);
      console.log(`[DEBUG] Checking cache: "${cacheKey}"`);

      let cached = await env.memy.get(cacheKey);
      if (cached) {
        console.log(`[DEBUG] Cache hit: "${cacheKey}"`);
        const cachedData = JSON.parse(cached);
        console.log(`[DEBUG] Cached data:`, cachedData);
        return new Response(JSON.stringify({
          answer: cachedData.answer,
          confidence: cachedData.confidence,
          citations: cachedData.citations,
          created: cachedData.created,
          userId: cachedData.userId,
          model: cachedData.model || modelKey,
          timestamp: cachedData.timestamp || cachedData.created,
          cached: true
        }), { headers: CORS_HEADERS });
      }

      console.log(`[DEBUG] Cache miss. Running inference...`);
      let context = '';
      if (historyStub) {
        try {
          const historyResponse = await historyStub.fetch('http://do/getHistory', { method: 'GET' });
          if (!historyResponse.ok) throw new Error(`History fetch failed: ${historyResponse.status}`);
          const history = await historyResponse.json();
          context = history.map(item => `User: ${item.query}\nAI: ${item.answer}`).join('\n');
          console.log(`[DEBUG] Built prompt with ${history.length} items from DO`);
        } catch (doError) {
          console.error('[DEBUG] DO Error (getHistory):', doError.message, doError.stack);
          context = '';
          console.log(`[DEBUG] Built prompt with NO context (DO error)`);
        }
      }

      const fullPrompt = env.AI_SYSTEM_PROMPT
        ? `${env.AI_SYSTEM_PROMPT}\n\n${context ? `CONTEXT:\n${context}\n\n` : ''}USER:\n${input}`
        : `${context ? `CONTEXT:\n${context}\n\n` : ''}USER:\n${input}`;

      const response = await this.callModel(env, modelKey, fullPrompt, input);

      if (historyStub) {
        try {
          await historyStub.fetch('http://do/addFollowUp', {
            method: 'POST',
            body: JSON.stringify({ query: input, answer: response.answer }),
          });
          console.log(`[DEBUG] Saved Q/A to DO`);
        } catch (doError) {
          console.error('[DEBUG] DO Error (addFollowUp):', doError.message, doError.stack);
        }
      }

      const cacheData = {
        answer: response.answer,
        model: modelKey,
        timestamp: Date.now(),
        confidence: null,
        citations: [],
        created: Date.now(),
        userId: null
      };

      await env.memy.put(cacheKey, JSON.stringify(cacheData));
      console.log(`[DEBUG] Saved inference to memy: "${cacheKey}"`);
      console.log(`[DEBUG] Returning new inference`);

      return new Response(JSON.stringify({ ...cacheData, cached: false }), {
        headers: CORS_HEADERS
      });
    } catch (error) {
      console.error('[DEBUG] CRITICAL FETCH ERROR:', error.message, error.stack);
      return new Response(JSON.stringify({ error: error.message || "Internal error" }), {
        status: 500,
        headers: CORS_HEADERS
      });
    }
  }

  async callModel(env, modelKey, prompt, input) {
    if (modelKey === 'WORKERS_AI') {
      if (!env.AI) throw new Error("AI binding not found");
      return this.callWorkersAI(env, prompt);
    } else {
      if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing");
      return this.callOpenRouter(env, modelKey, prompt, input);
    }
  }

  async callWorkersAI(env, prompt) {
    const messages = [];
    if (env.AI_SYSTEM_PROMPT) {
      messages.push({ role: "system", content: env.AI_SYSTEM_PROMPT });
    }
    messages.push({ role: "user", content: prompt });
    console.log(`[DEBUG-WORKERS-AI] Request:`, { model: MODELS.WORKERS_AI.model, messages });
    const response = await env.AI.run(MODELS.WORKERS_AI.model, { messages });
    console.log(`[DEBUG-WORKERS-AI] Response:`, response);
    return { answer: response.response };
  }

  async callOpenRouter(env, modelKey, prompt, input) {
    const modelConfig = MODELS[modelKey];
    const openRouterUrl = "https://openrouter.ai/api/v1/chat/completions";
    console.log(`[DEBUG-OPENROUTER] Model: ${modelKey}`);
    console.log(`[DEBUG-OPENROUTER] Config:`, modelConfig);
    const response = await fetch(openRouterUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://your-site-url.com",
        "X-Title": "Your Site Name"
      },
      body: JSON.stringify({
        model: modelConfig.model,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const responseStatus = response.status;
    const responseText = await response.text();
    console.log(`[DEBUG-OPENROUTER] Status: ${responseStatus}`);
    console.log(`[DEBUG-OPENROUTER] Body: ${responseText}`);
    if (!response.ok) throw new Error(`OpenRouter error: ${responseStatus} ${responseText}`);
    const data = JSON.parse(responseText);
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error(`Invalid OpenRouter response: ${JSON.stringify(data)}`);
    }
    if (data.usage) {
      console.log(`[DEBUG-OPENROUTER] Tokens: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}, total=${data.usage.total_tokens}`);
    }
    return { answer: data.choices[0].message.content };
  }

  normalizeQuery(query) {
    if (!query || typeof query !== "string") return "";
    return query.trim().toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 100);
  }

  async handleConversationRequest(request, env, historyStub) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!historyStub) {
      return new Response(JSON.stringify({ error: "Invalid Durable Object stub" }), {
        status: 500,
        headers: CORS_HEADERS
      });
    }
    if (path === '/conversation/history' && request.method === 'GET') {
      try {
        const historyResponse = await historyStub.fetch('http://do/getHistory', { method: 'GET' });
        const history = await historyResponse.json();
        return new Response(JSON.stringify(history), { headers: CORS_HEADERS });
      } catch (error) {
        console.error("[DEBUG] Error in /conversation/history:", error.message, error.stack);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
    return new Response(JSON.stringify({ error: "Invalid endpoint" }), {
      status: 404,
      headers: CORS_HEADERS
    });
  }
};

export class justice_Chat extends DurableObject {
  constructor(state) {
    super(state);
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      let history = await this.state.storage.get("history");
      if (!history) {
        console.log("[DEBUG] DO: Initializing empty history");
        await this.state.storage.set("history", []);
      }
      await this.state.storage.setAlarm(Date.now() + 2 * 60 * 60 * 1000);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/getHistory' && request.method === 'GET') {
      console.log("[DEBUG] DO: getHistory() called via fetch");
      const history = await this.state.storage.get("history") || [];
      return new Response(JSON.stringify(history), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/addFollowUp' && request.method === 'POST') {
      console.log("[DEBUG] DO: addFollowUp() called via fetch");
      const { query, answer } = await request.json();
      let history = await this.state.storage.get("history") || [];
      if (history.length >= 10) history.shift();
      history.push({ query, answer, timestamp: Date.now() });
      await this.state.storage.set("history", history);
      await this.state.storage.setAlarm(Date.now() + 2 * 60 * 60 * 1000);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response("Invalid endpoint", { status: 404, headers: CORS_HEADERS });
  }

  async alarm() {
    console.log("[DEBUG] DO Alarm: Clearing history");
    await this.state.storage.set("history", []);
  }
}

export default {
  fetch: (request, env) => new TruthEngine().fetch(request, env)
};