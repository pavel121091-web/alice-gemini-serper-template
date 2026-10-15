const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const FALLBACK_MODEL = "gemini-3.8-flash";
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_MESSAGE_CHARS = 800;
const MAX_ALICE_TEXT = 1024;
const SERPER_TIMEOUT_MS = 300;
const GEMINI_TIMEOUT_MS = 4300;

const SYSTEM_PROMPT = [
  "Ты — быстрый голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко (1–2 коротких предложения).",
  "Без Markdown, звездочек, списков, таблиц и ссылок.",
  "Если есть данные поиска — используй их. Если нет — отвечай кратко."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  const cleanText = fitAliceText(text);
  return {
    version: "1.0",
    response: { text: cleanText, tts: cleanText, end_session: Boolean(endSession) },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[*#_~`>|]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text) return "Не удалось подготовить ответ.";
  if (text.length <= MAX_ALICE_TEXT) return text;

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("! "), candidate.lastIndexOf("? "));
  if (sentenceEnd >= 200) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 150 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|search|202[5-9])\b|сегодня|сейчас|вчера|завтра|новост|погод|курс|найди|поищи|сколько стоит/i.test(text);
}

function isExitIntent(text) {
  return /^(хватит|стоп|выход|выйти|закрой|пока)$/i.test(text.trim());
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  const filtered = history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string" && item.text.trim())
    .map(item => ({ role: item.role, text: item.text.trim().slice(0, MAX_HISTORY_MESSAGE_CHARS) }));

  const normalized = [];
  for (const item of filtered) {
    if (normalized.length === 0) {
      if (item.role === "user") normalized.push(item);
      continue;
    }
    const prev = normalized[normalized.length - 1];
    if (prev.role !== item.role) {
      normalized.push(item);
    } else {
      normalized[normalized.length - 1] = item;
    }
  }

  const sliced = normalized.slice(-MAX_HISTORY_MESSAGES);
  if (sliced.length > 0 && sliced[0].role === "model") sliced.shift();
  return sliced;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const safeTimeout = Math.max(150, Math.floor(timeoutMs));
  const timer = setTimeout(() => controller.abort(), safeTimeout);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) {
      throw new Error("TIME_BUDGET_EXHAUSTED");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 2 })
      },
      timeoutMs
    );

    if (!response.ok) return "";

    const items = [];
    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.push(`Ответ: ${String(answerBox).slice(0, 200)}`);

    const organic = Array.isArray(data.organic) ? data.organic.slice(0, 2) : [];
    for (const item of organic) {
      const title = String(item.title || "").slice(0, 100);
      const snippet = String(item.snippet || "").slice(0, 200);
      if (title || snippet) items.push(`${title}: ${snippet}`);
    }
    return items.join("\n");
  } catch (error) {
    return "";
  }
}

async function callGeminiModel(modelName, text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext ? `Вопрос: ${text}\nДанные поиска:\n${searchContext}\nОтветь кратко.` : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  try {
    const { response, data } = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { temperature: 0.3, maxOutputTokens: 250 }
        })
      },
      timeoutMs
    );

    if (!response.ok) {
      const status = Number(response.status);
      if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
      if (status === 429) throw new Error("GEMINI_QUOTA");
      if (status === 503 || status === 404) throw new Error("GEMINI_OVERLOADED");
      throw new Error("GEMINI_REQUEST_FAILED");
    }

    const candidate = data?.candidates?.[0];
    const answer = (candidate?.content?.parts || [])
      .filter(part => !part?.thought && typeof part?.text === "string")
      .map(part => part.text)
      .join("")
      .trim();

    if (!answer) throw new Error("GEMINI_EMPTY_RESPONSE");
    return answer;
  } catch (error) {
    throw error;
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");

  const primaryModel = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  try {
    return await callGeminiModel(primaryModel, text, history, searchContext, timeoutMs);
  } catch (error) {
    console.warn(`Primary model ${primaryModel} failed:`, error.message);
    try {
      return await callGeminiModel(FALLBACK_MODEL, text, history, searchContext, Math.max(1000, timeoutMs - 500));
    } catch (fallbackError) {
      console.warn(`Fallback model ${FALLBACK_MODEL} failed:`, fallbackError.message);
      throw fallbackError;
    }
  }
}

function errorForUser(error) {
  const code = typeof error === "string" ? error : error?.message;
  switch (code) {
    case "MISSING_GEMINI_KEY": return "Сервер не настроен: нет ключа Gemini.";
    case "GEMINI_KEY_REJECTED": return "Ошибка авторизации в нейросети.";
    case "GEMINI_QUOTA": case "GEMINI_OVERLOADED": return "Нейросеть перегружена. Повторите запрос.";
    case "TIME_BUDGET_EXHAUSTED": case "AbortError": return "Слишком долгий ответ. Повторите короче.";
    default: return "Произошла заминка. Повторите вопрос.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "alice-gemini-serper" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const command = String(body?.request?.command || "").trim();
  const originalUtterance = String(body?.request?.original_utterance || "").trim();
  const text = originalUtterance || command;
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (command.toLowerCase() === "ping") {
    return res.status(200).json(aliceResponse("pong", true, oldHistory));
  }
  if (!text) {
    return res.status(200).json(aliceResponse("Привет! Что хочешь узнать?", false, oldHistory));
  }
  if (isExitIntent(command || text)) {
    return res.status(200).json(aliceResponse("Пока!", true, []));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      searchContext = await searchWeb(text, SERPER_TIMEOUT_MS);
    }

    const answer = await askGemini(text, oldHistory, searchContext, GEMINI_TIMEOUT_MS);

    const cleanAnswer = fitAliceText(answer);
    const history = safeHistory([
      ...oldHistory,
      { role: "user", text },
      { role: "model", text: cleanAnswer }
    ]);

    return res.status(200).json(aliceResponse(cleanAnswer, false, history));
  } catch (error) {
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
