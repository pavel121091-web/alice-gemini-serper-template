const DEFAULT_MODEL = "gemini-3.8-flash";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1000;
const MAX_ALICE_TEXT = 1024;

// Яндекс Диалоги ждут ответ до 5 секунд. Используем 4.8 сек с небольшим запасом.
const TOTAL_RESPONSE_BUDGET_MS = 4800;
const SERPER_TIMEOUT_MS = 850;
const GEMINI_TIMEOUT_MS = 3600;

const SYSTEM_PROMPT = [
  "Ты — быстрый и полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно воспринимать на слух.",
  "Используй 1–3 коротких предложения. Строго без Markdown, звездочек, списков, таблиц, ссылок и длинных вступлений.",
  "Числа и сокращения пиши так, чтобы их было легко прочитать вслух.",
  "Если переданы результаты поиска, опирайся на них и не выдумывай факты.",
  "Если точного ответа нет, честно и коротко скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  const cleanText = fitAliceText(text);
  return {
    version: "1.0",
    response: {
      text: cleanText,
      tts: cleanText,
      end_session: Boolean(endSession)
    },
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
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 250) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up|202[5-9])\b|сегодня|сейчас|вчера|завтра|последн|новост|погод|курс|найди|поищи|актуальн|сколько стоит|свежие|расписан|кто победил|счет матча|какой год|какое число/i.test(text);
}

function isExitIntent(text) {
  return /^(хватит|стоп|выход|выйти|закрой|закройся|пока|до свидания|закончить)$/i.test(text.trim());
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];

  const filtered = history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string" && item.text.trim())
    .map(item => ({
      role: item.role,
      text: item.text.trim().slice(0, MAX_HISTORY_MESSAGE_CHARS)
    }));

  // Гарантируем строгое чередование ролей (user -> model) во избежание HTTP 400 от Gemini
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
  if (sliced.length > 0 && sliced[0].role === "model") {
    sliced.shift();
  }
  return sliced;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const safeTimeout = Math.max(100, Math.floor(timeoutMs));
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
  if (!key || timeoutMs < 250) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = [];
    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) {
      items.push(`Быстрый ответ: ${String(answerBox).slice(0, 300)}`);
    }

    const kgDesc = data.knowledgeGraph?.description;
    if (kgDesc) {
      items.push(`Справка: ${String(kgDesc).slice(0, 250)}`);
    }

    const organic = Array.isArray(data.organic) ? data.organic.slice(0, 3) : [];
    for (let i = 0; i < organic.length; i++) {
      const item = organic[i];
      const title = String(item.title || "").slice(0, 140);
      const snippet = String(item.snippet || "").slice(0, 300);
      const date = item.date ? ` (${String(item.date).slice(0, 40)})` : "";
      if (title || snippet) {
        items.push(`${i + 1}. ${title}${date}: ${snippet}`.trim());
      }
    }

    return items.join("\n");
  } catch (error) {
    console.warn("Serper skipped or timed out:", error?.message || "unknown");
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 350) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const currentDate = new Date().toLocaleDateString("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const prompt = searchContext
    ? `Текущая дата: ${currentDate}.\nВопрос: ${text}\n\nРезультаты поиска:\n${searchContext}\nОтветь кратко на основе этих данных.`
    : text;

  contents.push({ role: "user", parts: [{ text: prompt }] });

  const generationConfig = {
    temperature: 0.4,
    maxOutputTokens: 400
  };

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `${SYSTEM_PROMPT} Сегодня ${currentDate}.` }]
        },
        contents,
        generationConfig
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini HTTP error:", status, JSON.stringify(data?.error?.message || ""));
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .filter(part => !part?.thought && typeof part?.text === "string")
    .map(part => part.text)
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY") {
      throw new Error("GEMINI_BLOCKED");
    }
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }

  return answer;
}

function errorForUser(error) {
  const code = typeof error === "string" ? error : error?.message;
  switch (code) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к нейросети. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к нейросети. Попробуйте через минуту.";
    case "GEMINI_BLOCKED":
      return "Я не могу ответить на этот запрос из-за ограничений безопасности. Спросите о чём-нибудь другом.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела получить ответ вовремя. Попробуйте повторить вопрос покороче.";
    default:
      return "Произошла небольшая заминка при обращении к нейросети. Повторите вопрос ещё раз.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const command = String(body?.request?.command || "").trim();
  const originalUtterance = String(body?.request?.original_utterance || "").trim();
  const text = originalUtterance || command;
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (command.toLowerCase() === "ping") {
    return res.status(200).json(aliceResponse("pong", true, oldHistory));
  }

  if (!text) {
    return res.status(200).json(
      aliceResponse(
        "Привет! Я помогу ответить на любой вопрос или найти свежую информацию. О чём рассказать?",
        false,
        oldHistory
      )
    );
  }

  if (isExitIntent(command || text)) {
    return res.status(200).json(
      aliceResponse("Была рада помочь! Обращайтесь ещё.", true, [])
    );
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      const searchBudget = Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2500));
      searchContext = await searchWeb(text, searchBudget);
    }

    const geminiBudget = Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 100));
    const answer = await askGemini(text, oldHistory, searchContext, geminiBudget);

    const cleanAnswer = fitAliceText(answer);
    const history = safeHistory([
      ...oldHistory,
      { role: "user", text },
      { role: "model", text: cleanAnswer }
    ]);

    return res.status(200).json(aliceResponse(cleanAnswer, false, history));
  } catch (error) {
    console.warn("Alice webhook fallback:", error?.message || error);
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
