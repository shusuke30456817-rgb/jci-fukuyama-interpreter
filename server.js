const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json'
};

// Google 翻訳 Web API（双方向対応・CORSゼロ・爆速）
function translateWithGoogle(text, sl = 'en', tl = 'ja') {
  return new Promise((resolve, reject) => {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=` + encodeURIComponent(text);
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    };
    https.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        console.error(`[Google Translate Error] HTTP ${res.statusCode} for text: "${text}"`);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let rawData = '';
      res.on('data', chunk => rawData += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(rawData);
          if (parsed && parsed[0]) {
            const result = parsed[0].map(item => item[0]).join('');
            resolve(result);
          } else {
            resolve('');
          }
        } catch (e) {
          console.error('[Google Translate JSON Parse Error]:', e.message);
          reject(e);
        }
      });
    }).on('error', (e) => {
      console.error('[Google Translate Request Error]:', e.message);
      reject(e);
    });
  });
}

// Gemini 2.0 Flash / 1.5 Flash による文脈考慮の意訳（双方向対応）
function translateWithGemini(text, apiKey, direction = 'en-ja') {
  return new Promise((resolve, reject) => {
    const model = 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const systemPrompt = direction === 'ja-en'
      ? 'あなたはJCI国際講演会のプロ同時通訳者です。入力された日本語のスピーチや質問を、外国人登壇者向けのスクリーン字幕に最適な自然で格調高い英語に翻訳してください。前置きや解説、引用符は一切出力せず、英語訳のみを1行で出力してください。'
      : 'あなたはJCI国際講演会のプロ同時通訳者です。入力された英語スピーチを、スクリーン字幕に最適な自然で格調高い日本語に翻訳してください。前置きや解説、引用符は一切出力せず、日本語訳のみを1行で出力してください。gritは「やり抜く力（グリット）」のように文脈に沿った自然な表現にしてください。';

    const payload = JSON.stringify({
      system_instruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [{
        parts: [{ text: text }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 250
      }
    });

    const parsedUrl = new URL(url);
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 900
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Gemini API HTTP ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          const candidate = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (candidate) {
            resolve(candidate.trim().replace(/^["「』](.*)["」』]$/, '$1'));
          } else {
            reject(new Error('No text in Gemini response'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gemini request socket timeout'));
    });
    req.write(payload);
    req.end();
  });
}

// ハイブリッド翻訳（800msタイムアウト付き。超えたら0.05秒のGoogle翻訳へ自動フォールバック）
async function translateHybrid(text, apiKey, direction = 'en-ja') {
  const [sl, tl] = direction === 'ja-en' ? ['ja', 'en'] : ['en', 'ja'];
  if (!apiKey) {
    return await translateWithGoogle(text, sl, tl);
  }

  const geminiPromise = translateWithGemini(text, apiKey, direction);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Gemini 800ms timeout exceeded')), 800)
  );

  try {
    const res = await Promise.race([geminiPromise, timeoutPromise]);
    if (res && res.length > 0) {
      console.log(`[Gemini AI Hybrid (${direction}) Success]: "${res}"`);
      return res;
    }
  } catch (err) {
    console.warn(`[Gemini Fallback -> Google Translate (${direction})]: ${err.message}`);
  }

  // タイムアウトまたはエラー時は即座にGoogle翻訳（0.05秒）で返す！
  return await translateWithGoogle(text, sl, tl);
}

// HTTP サーバー
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let reqPath = req.url.split('?')[0];

  // API: /api/translate
  if (reqPath === '/api/translate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { text, apiKey, mode, direction } = JSON.parse(body);
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Text required' }));
        }

        const dir = direction === 'ja-en' ? 'ja-en' : 'en-ja';
        let translated = '';
        if (mode === 'gemini-hybrid' && apiKey) {
          translated = await translateHybrid(text, apiKey, dir);
        } else {
          const [sl, tl] = dir === 'ja-en' ? ['ja', 'en'] : ['en', 'ja'];
          translated = await translateWithGoogle(text, sl, tl);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ja: translated, translated }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 静的ファイル配信
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(__dirname, reqPath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

// ============================================================================
// WebSocket サーバー（リアルタイム音声ストリーミング & Deepgram 中継）
// ============================================================================
const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs, req) => {
  console.log('[WebSocket] Client connected from', req.socket.remoteAddress);

  let deepgramWs = null;
  let clientApiKey = '';
  let clientGeminiKey = '';
  let clientInterpreterMode = 'gemini-hybrid'; // 'gemini-hybrid' | 'google-web'
  let clientDirection = 'en-ja'; // 'en-ja' (英語->日本語) | 'ja-en' (日本語->英語)
  let audioBufferQueue = [];
  let keepAliveInterval = null;

  // クライアントからのメッセージ処理
  clientWs.on('message', async (message, isBinary) => {
    // 1. テキストメッセージ（設定・制御）
    if (!isBinary) {
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === 'start') {
          clientApiKey = (msg.apiKey || '').trim();
          clientGeminiKey = (msg.geminiApiKey || '').trim();
          clientInterpreterMode = msg.interpreterMode || 'gemini-hybrid';
          clientDirection = msg.direction === 'ja-en' ? 'ja-en' : 'en-ja';
          console.log(`[WebSocket Start] Direction: ${clientDirection}, Mode: ${clientInterpreterMode}, Gemini Key: ${clientGeminiKey ? 'Present' : 'None'}`);
          setupDeepgramConnection(clientApiKey);
        } else if (msg.type === 'switch_direction') {
          clientDirection = msg.direction === 'ja-en' ? 'ja-en' : 'en-ja';
          console.log(`[WebSocket Switch Direction] New direction: ${clientDirection}`);
          if (deepgramWs && clientApiKey) {
            setupDeepgramConnection(clientApiKey);
          }
        } else if (msg.type === 'stop') {
          closeDeepgram();
        }
      } catch (e) {
        console.warn('[WebSocket] Invalid JSON message:', e.message);
      }
      return;
    }

    // 2. バイナリメッセージ（マイク生音声ストリーム）
    if (isBinary) {
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(message);
      } else {
        // Deepgram接続確立前の音声チャンク（WebMヘッダー等）を失わないようキューイング
        audioBufferQueue.push(message);
        if (audioBufferQueue.length > 50) {
          audioBufferQueue.shift(); // 最大バッファ制限
        }
      }
    }
  });

  // Deepgram WebSocket ストリーミング接続の確立
  function setupDeepgramConnection(apiKey) {
    if (!apiKey) {
      clientWs.send(JSON.stringify({
        type: 'error',
        message: 'Deepgram API キーが設定されていません。設定画面でAPIキーを入力してください。'
      }));
      return;
    }

    closeDeepgram();
    audioBufferQueue = [];

    // 言語設定: en (英->日) または ja (日->英)
    const dgLang = clientDirection === 'ja-en' ? 'ja' : 'en';
    const dgUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${dgLang}&smart_format=true&punctuate=true&interim_results=true&endpointing=700`;

    let accumulatedSentence = '';
    let lastTranslatedSentence = '';

    // 確定文をハイブリッド翻訳（Gemini AI 0.8秒保証 + Google 翻訳フォールバック）してクライアントへプッシュ
    async function translateAndSend(cleanSource) {
      if (!cleanSource || cleanSource.length < 2) return;
      try {
        let targetText = '';
        if (clientInterpreterMode === 'gemini-hybrid' && clientGeminiKey) {
          targetText = await translateHybrid(cleanSource, clientGeminiKey, clientDirection);
        } else {
          const [sl, tl] = clientDirection === 'ja-en' ? ['ja', 'en'] : ['en', 'ja'];
          targetText = await translateWithGoogle(cleanSource, sl, tl);
        }

        if (targetText) {
          console.log(`[Translation Output (${clientDirection})]: "${cleanSource}" -> "${targetText}"`);
          clientWs.send(JSON.stringify({
            type: 'translation',
            source: cleanSource,
            target: targetText,
            direction: clientDirection,
            en: clientDirection === 'ja-en' ? targetText : cleanSource,
            ja: clientDirection === 'ja-en' ? cleanSource : targetText
          }));
        }
      } catch (trErr) {
        console.error('[Translation Error]:', trErr.message);
      }
    }

    let currentDgWs = null;
    try {
      currentDgWs = new WebSocket(dgUrl, {
        headers: {
          'Authorization': `Token ${apiKey}`
        }
      });
      deepgramWs = currentDgWs;

      currentDgWs.on('open', () => {
        if (deepgramWs !== currentDgWs) return; // 既に別の接続に切り替わっている場合は無視
        console.log(`[Deepgram] Connected to Deepgram Nova-2 streaming API (${dgLang}, endpointing: 700ms)`);
        clientWs.send(JSON.stringify({
          type: 'deepgram_connected',
          direction: clientDirection
        }));

        // キューに溜まっていた音声チャンクを全て順序正しく送信
        if (audioBufferQueue.length > 0) {
          console.log(`[Deepgram] Flushing ${audioBufferQueue.length} buffered audio chunks`);
          while (audioBufferQueue.length > 0) {
            const chunk = audioBufferQueue.shift();
            if (currentDgWs && currentDgWs.readyState === WebSocket.OPEN) {
              try {
                currentDgWs.send(chunk);
              } catch (sendErr) {
                console.warn('[Deepgram Buffer Send Error]:', sendErr.message);
              }
            }
          }
        }

        // Deepgramのアイドル切断（10秒）を防ぐための定期KeepAlive
        clearInterval(keepAliveInterval);
        keepAliveInterval = setInterval(() => {
          if (currentDgWs && currentDgWs.readyState === WebSocket.OPEN) {
            try {
              currentDgWs.send(JSON.stringify({ type: 'KeepAlive' }));
            } catch (e) {}
          }
        }, 5000);
      });

      currentDgWs.on('message', async (data) => {
        if (deepgramWs !== currentDgWs) return;
        try {
          const res = JSON.parse(data.toString());

          // エラーまたは警告の検知
          if (res.error || res.err_code || res.type === 'Error') {
            console.error('[Deepgram Server Notice]:', res);
            clientWs.send(JSON.stringify({
              type: 'error',
              message: res.message || res.description || 'Deepgram 音声認識エラー'
            }));
            return;
          }

          const alt = res?.channel?.alternatives?.[0];
          const transcript = (alt?.transcript || '').trim();
          const confidence = alt?.confidence ?? 1.0;
          const isFinal = res?.is_final || false;
          const speechFinal = res?.speech_final || false;

          // ★【英日モード時の日本語・ノイズ誤爆防止（スキップ判定）】
          if (clientDirection === 'en-ja' && transcript) {
            // 1. confidence が極端に低い（< 0.40）場合は誤爆空耳とみなして無視
            if (confidence < 0.40) {
              console.log(`[Noise/Japanese Skipped (low confidence: ${confidence})]: "${transcript}"`);
              return;
            }
            // 2. 日本語文字（ひらがな・カタカナ・漢字）が含まれる場合はスキップ
            if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(transcript)) {
              console.log(`[Japanese in English mode Skipped]: "${transcript}"`);
              return;
            }
            // 3. 無意味な母音や相槌の単独断片（例: "ah", "uh", "eh", "oh", "um", "hai" 等）をスキップ
            const lower = transcript.toLowerCase().replace(/[^a-z]/g, '');
            const noiseWords = ['ah', 'uh', 'um', 'eh', 'oh', 'hai', 'un', 'ha', 'er'];
            if (noiseWords.includes(lower)) {
              console.log(`[Noise filler Skipped]: "${transcript}"`);
              return;
            }
          }

          // 1. クライアントへリアルタイム認識プレビューを配信
          if (transcript) {
            clientWs.send(JSON.stringify({
              type: 'transcript',
              text: transcript,
              isFinal: isFinal,
              speechFinal: speechFinal,
              direction: clientDirection
            }));

            if (isFinal) {
              const delimiter = clientDirection === 'ja-en' ? '' : ' ';
              accumulatedSentence += (accumulatedSentence ? delimiter : '') + transcript;
            }
          }

          // 2. 【完全な文基準のスマート抽出アルゴリズム】
          let trimmedAcc = accumulatedSentence.trim();

          if (clientDirection === 'ja-en') {
            // 【日本語認識モード】句読点「。」「！？\n」で完結文を抽出
            let jaMatch;
            while ((jaMatch = /(^.*?[。！？\n])(?:\s*|$)(.*)/s.exec(trimmedAcc)) !== null) {
              const completeSentence = jaMatch[1].trim();
              trimmedAcc = (jaMatch[2] || '').trim();
              accumulatedSentence = trimmedAcc;

              if (completeSentence.length >= 2 && completeSentence !== lastTranslatedSentence) {
                lastTranslatedSentence = completeSentence;
                console.log(`[Deepgram JA] Complete sentence: "${completeSentence}"`);
                translateAndSend(completeSentence);
              }
            }

            // 話者が一息ついた（speechFinal: 700msのポーズ）が句読点がつかなかった場合の救済
            if (speechFinal && trimmedAcc.length >= 4) {
              const sentenceToCommit = trimmedAcc;
              accumulatedSentence = '';
              if (sentenceToCommit !== lastTranslatedSentence) {
                lastTranslatedSentence = sentenceToCommit;
                console.log(`[Deepgram JA] SpeechFinal pause commit: "${sentenceToCommit}"`);
                translateAndSend(sentenceToCommit);
              }
            }

          } else {
            // 【英語認識モード】ピリオド等の文末記号（. ? !）で完結文を抽出
            let enMatch;
            while ((enMatch = /(^.*?[.?!])(?:\s+|$)(.*)/s.exec(trimmedAcc)) !== null) {
              const completeSentence = enMatch[1].trim();
              trimmedAcc = (enMatch[2] || '').trim();
              accumulatedSentence = trimmedAcc;

              if (completeSentence.length > 2 && completeSentence !== lastTranslatedSentence) {
                lastTranslatedSentence = completeSentence;
                console.log(`[Deepgram EN] Complete sentence: "${completeSentence}"`);
                translateAndSend(completeSentence);
              }
            }

            // 話者が一息ついた（speechFinal: 700msのポーズ）がピリオドが付かなかった場合の救済
            if (speechFinal && trimmedAcc.length > 3) {
              const words = trimmedAcc.split(/\s+/).filter(Boolean);
              const danglingWords = ['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'and', 'or', 'but', 'that', 'with', 'for', 'as', 'is', 'was', 'are', 'were'];
              const lastWord = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '');

              if (!danglingWords.includes(lastWord) && words.length >= 3) {
                const sentenceToCommit = trimmedAcc;
                accumulatedSentence = '';
                if (sentenceToCommit !== lastTranslatedSentence) {
                  lastTranslatedSentence = sentenceToCommit;
                  console.log(`[Deepgram EN] SpeechFinal pause commit: "${sentenceToCommit}"`);
                  translateAndSend(sentenceToCommit);
                }
              }
            }
          }
        } catch (err) {
          console.error('[Deepgram Parse Error]:', err.message);
        }
      });

      currentDgWs.on('error', (err) => {
        if (deepgramWs !== currentDgWs) return;
        console.error('[Deepgram WS Error]:', err.message);
        clientWs.send(JSON.stringify({
          type: 'error',
          message: `Deepgram 接続エラー: ${err.message}`
        }));
      });

      currentDgWs.on('close', (code, reason) => {
        console.log(`[Deepgram] Disconnected (code: ${code}, reason: ${reason})`);
        if (deepgramWs === currentDgWs) {
          clearInterval(keepAliveInterval);
          deepgramWs = null;
          clientWs.send(JSON.stringify({ type: 'deepgram_disconnected' }));
        }
      });

    } catch (err) {
      console.error('[Deepgram Setup Error]:', err.message);
      clientWs.send(JSON.stringify({
        type: 'error',
        message: `Deepgram 起動失敗: ${err.message}`
      }));
    }
  }

  function closeDeepgram() {
    clearInterval(keepAliveInterval);
    audioBufferQueue = [];
    if (deepgramWs) {
      const oldWs = deepgramWs;
      deepgramWs = null;
      try {
        oldWs.onopen = null;
        oldWs.onmessage = null;
        oldWs.onerror = null;
        oldWs.onclose = null;
        oldWs.close();
      } catch (e) {}
    }
  }

  clientWs.on('close', () => {
    console.log('[WebSocket] Client disconnected');
    closeDeepgram();
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/ with WebSocket streaming`);
});
