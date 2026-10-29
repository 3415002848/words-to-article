/**
 * 背单词 · AI 文章生成器
 * 一个单文件 Cloudflare Worker：承载前端页面 + OCR 识别 + AI 生成文章。
 *
 * 环境变量（在 Cloudflare 后台配置）：
 *   OCR_API_KEY     —— OCR.space 的 API Key
 *   DEEPSEEK_API_KEY —— DeepSeek 开放平台的 API Key
 */

// 简单限流：记录每个 IP 每天的调用次数（内存版，多实例下不严格，但能挡住大部分刷量）
const rateLimitMap = new Map(); // key: "ip:yyyy-mm-dd", value: count

const MAX_DAILY_CALLS = 50; // OCR/生成文章：每个 IP 每天最多调用次数
const MAX_DAILY_LOOKUPS = 200; // 查词：每个 IP 每天最多查询次数

function isRateLimited(ip, limit) {
  const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
  const key = ip + ':' + today + ':' + limit;
  const count = (rateLimitMap.get(key) || 0) + 1;
  rateLimitMap.set(key, count);
  return count > limit;
}

// 跨域头（方便本地测试；正式部署同域时无影响）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=utf-8', ...CORS_HEADERS },
  });
}

/**
 * 调用 DeepSeek（OpenAI 兼容接口），并解析 JSON 返回。
 * @param {number} temperature 随机性：0 最确定，1 最随机
 */
async function callDeepSeek(env, systemPrompt, userPrompt, temperature = 0.7) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: temperature,
      response_format: { type: 'json_object' }, // 强制返回 JSON，便于解析
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('DeepSeek 调用失败: ' + JSON.stringify(data));
  }
  const content = data.choices && data.choices[0] && data.choices[0].message.content;
  if (!content) {
    throw new Error('DeepSeek 未返回内容');
  }
  return JSON.parse(content);
}

/**
 * 处理 /api/ocr：接收图片 -> OCR 识别 -> DeepSeek 提取单词
 */
async function handleOCR(request, env, ip) {
  const formData = await request.formData();
  const file = formData.get('file');

  if (!file || typeof file === 'string') {
    return json({ error: '请上传图片文件' }, 400);
  }

  // 1. 调用 OCR.space 识别图片
  const ocrForm = new FormData();
  ocrForm.append('apikey', env.OCR_API_KEY);
  ocrForm.append('language', 'chs'); // 简体中文模式，可同时识别中英文
  ocrForm.append('file', file);

  const ocrRes = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { apikey: env.OCR_API_KEY },
    body: ocrForm,
  });

  const ocrData = await ocrRes.json();
  if (!ocrData || ocrData.OCRExitCode !== 1) {
    const msg = (ocrData && ocrData.ErrorMessage) || '未知错误';
    return json({ error: 'OCR 识别失败：' + msg }, 500);
  }

  const ocrText = (ocrData.ParsedResults && ocrData.ParsedResults[0] && ocrData.ParsedResults[0].ParsedText) || '';
  if (!ocrText.trim()) {
    return json({ error: '未识别到文字，请确认图片清晰、光线充足' }, 400);
  }

  // 2. 调用 DeepSeek 从杂乱的 OCR 文本中提取英语单词（低随机性，保证提取稳定）
  const extractSystem = '你是一个单词提取助手。你会收到 OCR 识别出的单词书页面文字，其中混有英语单词、音标、例句和中文释义。你的任务是只提取出需要背诵的英语单词。只返回 JSON。';
  const extractUser = '下面是 OCR 识别出的单词书页面文字：\n\n' + ocrText + '\n\n请只提取出其中需要背诵的英语单词，要求：\n1. 只保留英语单词本身（不要音标、例句、中文释义）\n2. 去掉重复的单词\n3. 保持单词原形\n4. 按每行一个单词整理成数组\n\n请严格按以下 JSON 格式返回：{"words": ["单词1", "单词2", "..."]}';

  const extracted = await callDeepSeek(env, extractSystem, extractUser, 0.1);
  const words = Array.isArray(extracted.words) ? extracted.words : [];

  return json({ ocrText, words });
}

// 文章难度选项（按考试类型）
const DIFFICULTY = {
  cet4: { label: '大学英语四级', desc: '词汇和句式符合大学英语四级（CET-4）难度，文章长度约 120~180 词' },
  cet6: { label: '大学英语六级', desc: '词汇和句式符合大学英语六级（CET-6）难度，文章长度约 150~220 词' },
  ielts: { label: '雅思', desc: '词汇和句式符合雅思（IELTS）学术难度，句式多样，文章长度约 200~280 词' },
  toefl: { label: '托福', desc: '词汇和句式符合托福（TOEFL）学术难度，逻辑清晰，文章长度约 200~280 词' },
};

/**
 * 处理 /api/generate：根据单词列表 + 难度生成文章 + 中文翻译 + 单词音标释义
 */
async function handleGenerate(request, env, ip) {
  const body = await request.json();
  const words = Array.isArray(body.words) ? body.words : [];
  const difficulty = DIFFICULTY[body.difficulty] ? body.difficulty : 'cet4';

  if (words.length === 0) {
    return json({ error: '单词列表为空' }, 400);
  }
  if (words.length > 60) {
    return json({ error: '单词过多（最多 60 个），请分批生成' }, 400);
  }

  const wordList = words.map((w) => String(w).trim()).filter(Boolean).join(', ');
  const diff = DIFFICULTY[difficulty];

  // 每次生成时加入随机编号，避免两次生成完全相同的文章
  const nonce = Math.random().toString(36).slice(2, 10);

  const genSystem = '你是一个英语写作助手，擅长为英语学习者编写包含指定词汇的短文。你总是返回合法的 JSON。';
  const genUser =
    '请用以下英语单词写一篇连贯的英语短文：\n\n' +
    wordList +
    '\n\n要求：\n' +
    '1. 文中必须出现上面列出的每一个单词（可以适当变化时态和单复数）\n' +
    '2. 每个目标单词在文章中用 **单词** 的格式加粗（两个星号包裹该单词）\n' +
    '3. 文章难度为「' + diff.label + '」：' + diff.desc + '\n' +
    '4. 提供全文中文翻译\n' +
    '5. 为每一个目标单词提供音标和中文释义\n' +
    '6. 请构思一个全新的、有创意的故事主题，不要套用常见模板（本次创作编号：' + nonce + '）\n\n' +
    '请严格按以下 JSON 格式返回：\n' +
    '{"article": "英文文章（目标单词用**加粗**）", "translation": "中文翻译全文", "vocab": {"单词原形": {"phonetic": "音标", "meaning": "中文释义"}}}';

  const result = await callDeepSeek(env, genSystem, genUser, 1.0);

  if (!result.article || !result.translation) {
    return json({ error: 'AI 返回格式异常，请重试' }, 500);
  }

  return json({
    article: result.article,
    translation: result.translation,
    vocab: result.vocab || {},
  });
}

/**
 * 处理 /api/lookup：查询单词的中文释义和音标（供前端悬停查词）
 */
async function handleLookup(request, env, ip) {
  const url = new URL(request.url);
  const word = (url.searchParams.get('word') || '').trim();
  if (!word) {
    return json({ error: '缺少单词' }, 400);
  }
  if (word.length > 50 || !/^[A-Za-z']+$/.test(word)) {
    return json({ error: '单词格式不正确' }, 400);
  }

  // 调用有道词典 jsonapi（免费、无需 key，返回音标和中文释义）
  const res = await fetch('https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(word), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });

  if (!res.ok) {
    return json({ error: '词典查询失败，请重试' }, 502);
  }

  const data = await res.json();

  // 解析英式音标（美式兜底）
  let phonetic = '';
  const sw = data && data.simple && data.simple.word && data.simple.word[0];
  if (sw) {
    phonetic = sw.ukphone || sw.usphone || '';
  }

  // 解析中文释义（完整释义优先，简明释义兜底）
  let meaning = '';
  const ew = data && data.ec && data.ec.word && data.ec.word[0];
  if (ew && ew.trs && ew.trs[0] && ew.trs[0].tr && ew.trs[0].tr[0] && ew.trs[0].tr[0].l && ew.trs[0].tr[0].l.i) {
    meaning = ew.trs[0].tr[0].l.i.join('; ');
  } else if (data && data.individual && data.individual.trs && data.individual.trs[0] && data.individual.trs[0].tran) {
    meaning = data.individual.trs[0].tran;
  }

  if (!meaning) meaning = '未找到释义';

  return json({
    word: word,
    phonetic: phonetic,
    meaning: meaning,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // 处理预检请求（CORS）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 前端页面
    if (path === '/' || path === '/index.html') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html;charset=utf-8' },
      });
    }

    // API 限流：OCR/生成 与 查词 分开计数
    if ((path === '/api/ocr' || path === '/api/generate') && isRateLimited(ip, MAX_DAILY_CALLS)) {
      return json({ error: '今日调用次数已达上限，请明天再来' }, 429);
    }
    if (path === '/api/lookup' && isRateLimited(ip, MAX_DAILY_LOOKUPS)) {
      return json({ error: '今日查询次数已达上限，请明天再来' }, 429);
    }

    try {
      if (path === '/api/ocr' && request.method === 'POST') {
        return await handleOCR(request, env, ip);
      }
      if (path === '/api/generate' && request.method === 'POST') {
        return await handleGenerate(request, env, ip);
      }
      if (path === '/api/lookup') {
        return await handleLookup(request, env, ip);
      }
      return json({ error: '接口不存在' }, 404);
    } catch (err) {
      return json({ error: '服务器错误：' + (err && err.message) }, 500);
    }
  },
};

// =====================================================================
// 以下是内嵌的前端页面（HTML + CSS + JS）
// =====================================================================
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>背单词 · AI 文章生成器</title>
<style>
  :root {
    --primary: #4f46e5;
    --primary-dark: #4338ca;
    --bg: #f5f6fa;
    --card: #ffffff;
    --text: #1f2937;
    --muted: #6b7280;
    --border: #e5e7eb;
    --accent: #fef3c7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 24px 16px;
  }
  .container { max-width: 720px; margin: 0 auto; }
  h1 {
    text-align: center;
    font-size: 26px;
    margin-bottom: 4px;
    color: var(--primary-dark);
  }
  .subtitle { text-align: center; color: var(--muted); font-size: 14px; margin-bottom: 28px; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 24px;
    margin-bottom: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }
  .step { font-weight: 600; color: var(--primary); margin-bottom: 12px; }
  .step-num {
    display: inline-block;
    background: var(--primary);
    color: #fff;
    width: 24px; height: 24px;
    line-height: 24px;
    text-align: center;
    border-radius: 50%;
    font-size: 13px;
    margin-right: 8px;
  }
  .dropzone {
    border: 2px dashed var(--border);
    border-radius: 10px;
    padding: 36px 16px;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s;
    color: var(--muted);
  }
  .dropzone:hover, .dropzone.dragover { border-color: var(--primary); background: #fafaff; }
  .dropzone img.preview { max-width: 100%; max-height: 240px; border-radius: 8px; margin-bottom: 8px; }
  textarea {
    width: 100%;
    min-height: 160px;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    font-size: 15px;
    font-family: inherit;
    resize: vertical;
  }
  textarea:focus { outline: none; border-color: var(--primary); }
  .btn {
    display: inline-block;
    background: var(--primary);
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 11px 22px;
    font-size: 15px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .btn:hover { background: var(--primary-dark); }
  .btn:disabled { background: #c7c9d4; cursor: not-allowed; }
  .btn.secondary { background: #fff; color: var(--primary); border: 1px solid var(--primary); }
  .btn.secondary:hover { background: #f5f5ff; }
  .hidden { display: none !important; }
  .loading {
    text-align: center;
    color: var(--muted);
    padding: 20px 0;
    font-size: 15px;
  }
  .spinner {
    display: inline-block;
    width: 16px; height: 16px;
    border: 2px solid var(--primary);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: -2px;
    margin-right: 8px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .article-box {
    font-size: 17px;
    line-height: 1.9;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .article-box strong.vocab-word {
    background: var(--accent);
    padding: 0 4px;
    border-radius: 4px;
    font-weight: 700;
    cursor: pointer;
  }
  .article-box strong.vocab-word:hover { background: #fde68a; }
  .article-box span.plain-word { cursor: pointer; }
  .article-box span.plain-word:hover { background: #eef2ff; border-radius: 3px; }
  .divider { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
  .translation-box {
    color: #374151;
    font-size: 15px;
    line-height: 1.8;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .translation-title { font-weight: 600; color: var(--primary-dark); margin-bottom: 8px; }
  .error { color: #dc2626; font-size: 14px; margin-top: 10px; }
  .word-count { color: var(--muted); font-size: 13px; margin-top: 8px; }
  .hint { font-size: 13px; color: var(--muted); margin-top: 8px; }
  .difficulty-box {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .difficulty-label { font-weight: 600; color: var(--text); }
  .diff-option { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font-size: 15px; }
  .diff-option input { cursor: pointer; }
  .word-tooltip {
    position: absolute;
    z-index: 1000;
    background: #1f2937;
    color: #fff;
    padding: 10px 14px;
    border-radius: 10px;
    box-shadow: 0 6px 18px rgba(0,0,0,0.25);
    max-width: 280px;
    pointer-events: none;
    font-size: 14px;
    line-height: 1.5;
  }
  .word-tooltip .tip-word { font-size: 17px; font-weight: 700; margin-bottom: 3px; }
  .word-tooltip .tip-phonetic { color: #a5b4fc; font-size: 14px; margin-bottom: 4px; }
  .word-tooltip .tip-meaning { font-size: 14px; color: #e5e7eb; line-height: 1.5; }
</style>
</head>
<body>
<div class="container">
  <h1>📚 背单词 · AI 文章生成器</h1>
  <p class="subtitle">上传单词书照片，AI 帮你生成一篇文章，边读边记单词</p>

  <!-- 第一步：上传图片 -->
  <div class="card" id="step1">
    <div class="step"><span class="step-num">1</span>上传单词书照片</div>
    <div class="dropzone" id="dropzone">
      <img id="preview" class="preview hidden" alt="预览">
      <div id="dropText">
        <p style="font-size:32px;">📷</p>
        <p>点击选择图片，或将图片拖到这里</p>
        <p class="hint">支持 JPG / PNG，建议拍摄清晰的单词页面</p>
      </div>
    </div>
    <input type="file" id="fileInput" accept="image/*" class="hidden">
    <div class="loading hidden" id="ocrLoading"><span class="spinner"></span>正在识别单词，请稍候…</div>
    <div class="error hidden" id="ocrError"></div>
  </div>

  <!-- 第二步：确认单词 -->
  <div class="card hidden" id="step2">
    <div class="step"><span class="step-num">2</span>确认要背诵的单词</div>
    <p class="hint" style="margin-bottom:8px;">已识别出以下单词，请检查：可删除识别错的词、补充遗漏的词（每行一个单词）</p>
    <textarea id="wordTextarea"></textarea>
    <div class="word-count" id="wordCount"></div>
    <div class="difficulty-box">
      <span class="difficulty-label">文章难度：</span>
      <label class="diff-option"><input type="radio" name="difficulty" value="cet4" checked> 四级</label>
      <label class="diff-option"><input type="radio" name="difficulty" value="cet6"> 六级</label>
      <label class="diff-option"><input type="radio" name="difficulty" value="ielts"> 雅思</label>
      <label class="diff-option"><input type="radio" name="difficulty" value="toefl"> 托福</label>
    </div>
    <div style="margin-top:14px;">
      <button class="btn" id="generateBtn">✨ 生成文章</button>
      <button class="btn secondary" id="reuploadBtn">重新上传图片</button>
    </div>
    <div class="loading hidden" id="genLoading"><span class="spinner"></span>AI 正在写文章，请稍候…</div>
    <div class="error hidden" id="genError"></div>
  </div>

  <!-- 第三步：文章结果 -->
  <div class="card hidden" id="step3">
    <div class="step"><span class="step-num">3</span>文章结果</div>
    <p class="hint" style="margin-bottom:12px;">💡 点击任意单词，即可查看读音和中文释义</p>
    <div class="article-box" id="articleBox"></div>
    <hr class="divider">
    <div class="translation-title">中文翻译</div>
    <div class="translation-box" id="translationBox"></div>
    <div style="margin-top:16px;">
      <button class="btn secondary" id="againBtn">再生成一篇</button>
    </div>
  </div>

  <p class="subtitle" style="margin-top:20px;">免费使用 · 单词由 AI 自动识别 · 文章由 AI 生成</p>
</div>

<div class="word-tooltip hidden" id="wordTooltip">
  <div class="tip-word" id="tipWord"></div>
  <div class="tip-phonetic" id="tipPhonetic"></div>
  <div class="tip-meaning" id="tipMeaning"></div>
</div>

<script>
  var dropzone = document.getElementById('dropzone');
  var fileInput = document.getElementById('fileInput');
  var preview = document.getElementById('preview');
  var dropText = document.getElementById('dropText');
  var ocrLoading = document.getElementById('ocrLoading');
  var ocrError = document.getElementById('ocrError');
  var step1 = document.getElementById('step1');
  var step2 = document.getElementById('step2');
  var step3 = document.getElementById('step3');
  var wordTextarea = document.getElementById('wordTextarea');
  var wordCount = document.getElementById('wordCount');
  var generateBtn = document.getElementById('generateBtn');
  var reuploadBtn = document.getElementById('reuploadBtn');
  var againBtn = document.getElementById('againBtn');
  var genLoading = document.getElementById('genLoading');
  var genError = document.getElementById('genError');
  var articleBox = document.getElementById('articleBox');
  var translationBox = document.getElementById('translationBox');
  var wordTooltip = document.getElementById('wordTooltip');
  var tipWord = document.getElementById('tipWord');
  var tipPhonetic = document.getElementById('tipPhonetic');
  var tipMeaning = document.getElementById('tipMeaning');
  var currentVocab = {}; // 目标单词的音标和释义（key 为小写原形）
  var dictCache = {}; // 普通单词的词典查询缓存（key 为小写单词）

  dropzone.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  dropzone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', function () {
    dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  function handleFile(file) {
    if (!file.type.startsWith('image/')) {
      showError(ocrError, '请上传图片文件');
      return;
    }
    // 预览
    var reader = new FileReader();
    reader.onload = function (e) {
      preview.src = e.target.result;
      preview.classList.remove('hidden');
      dropText.classList.add('hidden');
    };
    reader.readAsDataURL(file);

    uploadOCR(file);
  }

  function uploadOCR(file) {
    ocrError.classList.add('hidden');
    ocrLoading.classList.remove('hidden');

    var formData = new FormData();
    formData.append('file', file);

    fetch('/api/ocr', { method: 'POST', body: formData })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        ocrLoading.classList.add('hidden');
        if (data.error) {
          showError(ocrError, data.error);
          return;
        }
        wordTextarea.value = data.words.join('\\n');
        updateWordCount();
        step1.classList.add('hidden');
        step2.classList.remove('hidden');
      })
      .catch(function () {
        ocrLoading.classList.add('hidden');
        showError(ocrError, '网络错误，请重试');
      });
  }

  function updateWordCount() {
    var words = getWords();
    wordCount.textContent = '共 ' + words.length + ' 个单词';
  }
  wordTextarea.addEventListener('input', updateWordCount);

  function getWords() {
    return wordTextarea.value.split('\\n').map(function (w) { return w.trim(); }).filter(function (w) { return w !== ''; });
  }

  function getDifficulty() {
    var radios = document.getElementsByName('difficulty');
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) return radios[i].value;
    }
    return 'cet4';
  }

  function generateArticle() {
    var words = getWords();
    if (words.length === 0) {
      showError(genError, '请至少输入一个单词');
      return;
    }
    genError.classList.add('hidden');
    genLoading.classList.remove('hidden');
    generateBtn.disabled = true;

    fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: words, difficulty: getDifficulty() })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        genLoading.classList.add('hidden');
        generateBtn.disabled = false;
        if (data.error) {
          showError(genError, data.error);
          return;
        }
        currentVocab = normalizeVocab(data.vocab);
        renderArticle(data.article, data.translation);
      })
      .catch(function () {
        genLoading.classList.add('hidden');
        generateBtn.disabled = false;
        showError(genError, '网络错误，请重试');
      });
  }

  // 渲染文章：目标单词加粗，所有单词都包上可交互的标签
  function renderArticle(article, translation) {
    articleBox.innerHTML = renderArticleHTML(article);
    translationBox.textContent = translation;
    step2.classList.add('hidden');
    step3.classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  function renderArticleHTML(text) {
    // 先转义 HTML，防止注入
    var escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // 按 ** 分割：奇数段是目标单词（加粗），偶数段是普通文本
    var parts = escaped.split('**');
    var html = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        html += '<strong class="vocab-word" data-word="' + parts[i] + '">' + parts[i] + '</strong>';
      } else {
        html += wrapPlainText(parts[i]);
      }
    }
    return html;
  }

  // 把普通文本里的每个单词包上可交互的 span
  function wrapPlainText(text) {
    return text.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, function (w) {
      return '<span class="plain-word" data-word="' + w + '">' + w + '</span>';
    });
  }

  // 将 vocab 的 key 统一转小写，方便匹配
  function normalizeVocab(vocab) {
    var result = {};
    for (var k in vocab) {
      if (vocab.hasOwnProperty(k)) {
        result[String(k).toLowerCase()] = vocab[k];
      }
    }
    return result;
  }

  // 将文章里出现的单词（可能有变形）还原到 vocab 中的原形
  function normalizeWord(w) {
    w = String(w).toLowerCase().replace(/[^a-z']/g, '');
    if (currentVocab[w]) return w;
    var candidates = [];
    if (w.slice(-3) === 'ies') candidates.push(w.slice(0, -3) + 'y');
    if (w.slice(-2) === 'es') candidates.push(w.slice(0, -2));
    if (w.slice(-1) === 's') candidates.push(w.slice(0, -1));
    if (w.slice(-2) === 'ed') candidates.push(w.slice(0, -2), w.slice(0, -1));
    if (w.slice(-3) === 'ing') candidates.push(w.slice(0, -3), w.slice(0, -3) + 'e');
    for (var i = 0; i < candidates.length; i++) {
      if (currentVocab[candidates[i]]) return candidates[i];
    }
    return null;
  }

  function showTooltip(word, phonetic, meaning, anchor) {
    tipWord.textContent = word;
    tipPhonetic.textContent = phonetic || '';
    tipMeaning.textContent = meaning || '未找到释义';
    wordTooltip.classList.remove('hidden');
    positionTooltip(anchor);
  }

  function hideTooltip() {
    wordTooltip.classList.add('hidden');
  }

  // 把 tooltip 定位在单词上方（空间不够则放下方）
  function positionTooltip(anchor) {
    var rect = anchor.getBoundingClientRect();
    var tipW = wordTooltip.offsetWidth;
    var tipH = wordTooltip.offsetHeight;
    var left = rect.left + window.scrollX + rect.width / 2 - tipW / 2;
    var top = rect.top + window.scrollY - tipH - 8;
    if (top < window.scrollY + 4) {
      top = rect.top + window.scrollY + rect.height + 8;
    }
    var minLeft = window.scrollX + 8;
    var maxLeft = window.scrollX + document.documentElement.clientWidth - tipW - 8;
    if (left < minLeft) left = minLeft;
    if (left > maxLeft) left = maxLeft;
    wordTooltip.style.left = left + 'px';
    wordTooltip.style.top = top + 'px';
  }

  // 点击单词时触发：目标单词用预置释义，普通单词查词典
  function onWordLookup(el) {
    var word = el.getAttribute('data-word');
    var key = normalizeWord(word);
    if (key && currentVocab[key]) {
      showTooltip(key, currentVocab[key].phonetic, currentVocab[key].meaning, el);
    } else {
      lookupDictionary(word, el);
    }
  }

  // 调用后端查询单词的中文释义和音标
  function lookupDictionary(word, el) {
    var clean = String(word).toLowerCase().replace(/[^a-z']/g, '');
    if (!clean) return;
    if (dictCache[clean]) {
      showTooltip(clean, dictCache[clean].phonetic, dictCache[clean].meaning, el);
      return;
    }
    showTooltip(clean, '', '查询中…', el);
    var anchor = el;
    fetch('/api/lookup?word=' + encodeURIComponent(clean))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          showTooltip(clean, '', data.error, anchor);
          return;
        }
        dictCache[clean] = { phonetic: data.phonetic, meaning: data.meaning };
        showTooltip(data.word || clean, data.phonetic, data.meaning, anchor);
      })
      .catch(function () {
        showTooltip(clean, '', '查询失败，请重试', anchor);
      });
  }

  // 点击单词显示释义，点击其他位置隐藏
  articleBox.addEventListener('click', function (e) {
    var t = e.target;
    if (t.classList && (t.classList.contains('vocab-word') || t.classList.contains('plain-word'))) {
      onWordLookup(t);
      e.stopPropagation();
    }
  });

  document.addEventListener('click', function () {
    hideTooltip();
  });

  generateBtn.addEventListener('click', generateArticle);

  reuploadBtn.addEventListener('click', function () {
    step2.classList.add('hidden');
    step1.classList.remove('hidden');
    preview.classList.add('hidden');
    dropText.classList.remove('hidden');
    fileInput.value = '';
    ocrError.classList.add('hidden');
  });

  againBtn.addEventListener('click', function () {
    step3.classList.add('hidden');
    step2.classList.remove('hidden');
    hideTooltip();
  });

  function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
</script>
</body>
</html>`;
