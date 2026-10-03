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

// Google 翻訳 Web API（CORSゼロ・爆速）
function translateWithGoogle(text) {
  return new Promise((resolve, reject) => {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=' + encodeURIComponent(text);
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

// Gemini 2.0 Flash / 1.5 Flash による文脈考慮の意訳
function translateWithGemini(text, apiKey) {
  return new Promise((resolve, reject) => {
    const model = 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = JSON.stringify({
      system_instruction: {
        parts: [{
          text: 'あなたはJCI国際講演会のプロ同時通訳者です。入力された英語スピーチを、スクリーン字幕に最適な自然で格調高い日本語に翻訳してください。前置きや解説、引用符は一切出力せず、日本語訳のみを1行で出力してください。gritは「やり抜く力（グリット）」のように文脈に沿った自然な表現にしてください。'
        }]
      },
      contents: [{
        parts: [{ text: text }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 200
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
async function translateHybrid(text, apiKey) {
  if (!apiKey) {
    return await translateWithGoogle(text);
  }

  const geminiPromise = translateWithGemini(text, apiKey);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Gemini 800ms timeout exceeded')), 800)
  );

  try {
    const ja = await Promise.race([geminiPromise, timeoutPromise]);
    if (ja && ja.length > 0) {
      console.log(`[Gemini AI Hybrid Success]: "${ja}"`);
      return ja;
    }
  } catch (err) {
    console.warn(`[Gemini Fallback -> Google Translate]: ${err.message}`);
  }

  // タイムアウトまたはエラー時は即座にGoogle翻訳（0.05秒）で返す！
  return await translateWithGoogle(text);
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
        const { text, apiKey, mode } = JSON.parse(body);
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Text required' }));
        }

        let ja = '';
        if (mode === 'gemini-hybrid' && apiKey) {
          ja = await translateHybrid(text, apiKey);
        } else {
          ja = await translateWithGoogle(text);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ja }));
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
          console.log(`[WebSocket Start] Mode: ${clientInterpreterMode}, Gemini Key: ${clientGeminiKey ? 'Present' : 'None'}`);
          setupDeepgramConnection(clientApiKey);
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

    // Deepgram Nova-2 リアルタイムストリーミングエンドポイント
    // endpointing=700 (話者の自然な息継ぎ・ポーズ700msを待つことで途切れを防止)
    const dgUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&punctuate=true&interim_results=true&endpointing=700';

    let accumulatedSentence = '';
    let lastTranslatedSentence = '';

    // 確定文をハイブリッド翻訳（Gemini AI 0.8秒保証 + Google 翻訳フォールバック）してクライアントへプッシュ
    async function translateAndSend(cleanEn) {
      if (!cleanEn || cleanEn.length < 2) return;
      try {
        let ja = '';
        if (clientInterpreterMode === 'gemini-hybrid' && clientGeminiKey) {
          ja = await translateHybrid(cleanEn, clientGeminiKey);
        } else {
          ja = await translateWithGoogle(cleanEn);
        }

        if (ja) {
          console.log(`[Translation Output]: "${ja}"`);
          clientWs.send(JSON.stringify({
            type: 'translation',
            en: cleanEn,
            ja: ja
          }));
        }
      } catch (trErr) {
        console.error('[Translation Error]:', trErr.message);
      }
    }

    try {
      deepgramWs = new WebSocket(dgUrl, {
        headers: {
          'Authorization': `Token ${apiKey}`
        }
      });

      deepgramWs.on('open', () => {
        console.log('[Deepgram] Connected to Deepgram Nova-2 streaming API (endpointing: 700ms)');
        clientWs.send(JSON.stringify({ type: 'deepgram_connected' }));

        // キューに溜まっていた音声チャンクを全て順序正しく送信
        if (audioBufferQueue.length > 0) {
          console.log(`[Deepgram] Flushing ${audioBufferQueue.length} buffered audio chunks`);
          while (audioBufferQueue.length > 0) {
            const chunk = audioBufferQueue.shift();
            deepgramWs.send(chunk);
          }
        }

        // Deepgramのアイドル切断（10秒）を防ぐための定期KeepAlive
        clearInterval(keepAliveInterval);
        keepAliveInterval = setInterval(() => {
          if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 5000);
      });

      deepgramWs.on('message', async (data) => {
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
          const isFinal = res?.is_final || false;
          const speechFinal = res?.speech_final || false;

          // 1. クライアントへリアルタイム認識プレビューを配信
          if (transcript) {
            clientWs.send(JSON.stringify({
              type: 'transcript',
              text: transcript,
              isFinal: isFinal,
              speechFinal: speechFinal
            }));

            if (isFinal) {
              accumulatedSentence += (accumulatedSentence ? ' ' : '') + transcript;
            }
          }

          // 2. 【完全な文（. ? !）基準のスマート抽出アルゴリズム】
          // 文の途中でぶった切らず、ピリオド等の文末記号が来た完結文のみを切り出して翻訳！
          // 未完の断片はバッファに残して次の文とつなげる。
          let trimmedAcc = accumulatedSentence.trim();

          // 文末記号（. ? !）で区切られた完全な文をループで全て処理
          let match;
          while ((match = /(^.*?[.?!])(?:\s+|$)(.*)/s.exec(trimmedAcc)) !== null) {
            const completeSentence = match[1].trim();
            trimmedAcc = (match[2] || '').trim();
            accumulatedSentence = trimmedAcc; // 未完部分だけバッファに残す

            if (completeSentence.length > 2 && completeSentence !== lastTranslatedSentence) {
              lastTranslatedSentence = completeSentence;
              console.log(`[Deepgram] Complete sentence: "${completeSentence}"`);
              translateAndSend(completeSentence);
            }
          }

          // 3. 話者が一息ついた（speechFinal: 700msのポーズ）が、ピリオドが付かなかった場合の救済
          if (speechFinal && trimmedAcc.length > 3) {
            const words = trimmedAcc.split(/\s+/).filter(Boolean);
            const danglingWords = ['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'and', 'or', 'but', 'that', 'with', 'for', 'as', 'is', 'was', 'are', 'were'];
            const lastWord = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '');

            // 末尾が接続詞・前置詞等でなく、3単語以上あれば安全に確定
            if (!danglingWords.includes(lastWord) && words.length >= 3) {
              const sentenceToCommit = trimmedAcc;
              accumulatedSentence = '';
              if (sentenceToCommit !== lastTranslatedSentence) {
                lastTranslatedSentence = sentenceToCommit;
                console.log(`[Deepgram] SpeechFinal pause commit: "${sentenceToCommit}"`);
                translateAndSend(sentenceToCommit);
              }
            }
          }
        } catch (err) {
          console.error('[Deepgram Parse Error]:', err.message);
        }
      });

      deepgramWs.on('error', (err) => {
        console.error('[Deepgram WS Error]:', err.message);
        clientWs.send(JSON.stringify({
          type: 'error',
          message: `Deepgram 接続エラー: ${err.message}`
        }));
      });

      deepgramWs.on('close', (code, reason) => {
        console.log(`[Deepgram] Disconnected (code: ${code}, reason: ${reason})`);
        clearInterval(keepAliveInterval);
        clientWs.send(JSON.stringify({ type: 'deepgram_disconnected' }));
        deepgramWs = null;
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
      try {
        deepgramWs.close();
      } catch (e) {}
      deepgramWs = null;
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
