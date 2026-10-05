/**
 * JCI Fukuyama Live Interpreter - Smart Sentence Chunking Engine (v23)
 * TEDトークのような早口・連続スピーチでも単語のブツ切り（kids, wellなど）を完全に排除し、
 * 意味のある自然な「文のかたまり（Chunk）」として0.05秒超爆速で積み上げるスマート同時通訳システム。
 */

(() => {
  'use strict';

  // --- アプリケーション状態 ---
  const state = {
    isRecording: false,
    direction: 'en-ja', // 'en-ja' (英語->日本語・通常モード) | 'ja-en' (日本語->英語・質疑応答モード)
    apiKey: '', // Gemini API Key
    deepgramApiKey: '', // Deepgram API Key
    sttEngine: 'deepgram', // 'deepgram' (推奨・TED/早口完全対応) | 'webspeech'
    fontSize: 'large',
    interpreterMode: 'google-web', // 'google-web' (最速・完全安定) | 'gemini-text'
    chunkInterval: 4500,

    // WebSocket / Deepgram ストリーミング用
    webSocket: null,
    mediaRecorder: null,

    // Web Speech API（フォールバック用）
    speechRecognition: null,
    recognitionRestartTimer: null,
    committedIndex: 0,
    currentAccumulatedText: '',
    lastProcessedSentence: '',
    lastProcessedTime: 0,
    speechDebounceTimer: null,

    // オーディオ音量メーター用
    mediaStream: null,
    audioContext: null,
    analyser: null,
    volumeAnimationId: null,

    // 直前文脈の保持
    recentContext: []
  };

  // --- 実際の本番スピーチ原稿（テスト用） ---
  const ACTUAL_SPEECH_DATA = [
    { en: "Good evening, ladies and gentlemen, it is a real pleasure to be standing here with you tonight.", ja: "皆様、こんばんは。今夜、皆様の前に立つことができ、心より嬉しく思います。" },
    { en: "Thank you very much to the organizers and to everyone gathered here for this gracious welcome.", ja: "このような温かい歓迎をいただき、主催者の皆様、そしてここにお集まりのすべての皆様に心から感謝申し上げます。" },
    { en: "Tonight, I would like to talk about the quiet, steady efforts that build a great community.", ja: "今夜は、素晴らしい地域社会を築き上げるための、静かで着実な取り組みについてお話ししたいと思います。" },
    { en: "The greatest achievements never begin on a grand stage.", ja: "最も偉大な功績というものは、決して華やかな大舞台から始まるものではありません。" },
    { en: "They begin quietly in workshops, in small town halls, and in local meeting rooms just like this one.", ja: "それらは作業場や、小さな町の公会堂、そしてまさに今夜のような地域の会議室の中で静かに始まるのです。" },
    { en: "Throughout history, every major turning point was driven by people who took responsibility for their own community.", ja: "歴史を通じて、あらゆる大きな転換点は、自らの地域社会に責任を持った人々の手によって切り拓かれてきました。" },
    { en: "Today, we face a changing world with climate issues, technology shifts, and economic uncertainty.", ja: "今日、私たちは気候変動、技術の急変、そして経済の不確実性といった変化の時代に直面しています。" },
    { en: "However, history shows us that the best solutions are always local solutions.", ja: "しかし、歴史が教えてくれるように、最善の解決策は常に「地域に根ざした解決策」なのです。" },
    { en: "When neighbors talk to neighbors and local enterprises innovate, real solutions are born.", ja: "隣人同士が語り合い、地域の企業が革新を起こすとき、本物の解決策が生まれます。" },
    { en: "Consider our physical infrastructure: the roads, the electrical grids, and the clean energy that sustains our future.", ja: "私たちが歩く道路、電力を届ける送電網、未来を支えるクリーンエネルギーといった社会基盤を考えてみてください。" },
    { en: "These are not just technical systems. They are the foundation of trust, safety, and human dignity.", ja: "これらは単なる技術的システムではありません。信頼、安全、そして人間の尊厳そのものの基盤なのです。" },
    { en: "And they depend entirely on the hands of skilled, dedicated people.", ja: "そしてそれらは、熟練した献身的な人々の手によって完全に支えられています。" },
    { en: "Progress is a marathon, not a sprint. It is built day by day through steady, reliable efforts.", ja: "進歩とはスプリントではなくマラソンです。日々の着実で確実な努力の積み重ねによって築かれます。" },
    { en: "You are the ones shaping that future. Your passion and pride are the true drivers of progress.", ja: "その未来を創り出すのは皆様です。皆様の情熱と郷土への誇りこそが、進歩の真の原動力なのです。" },
    { en: "Thank you very much for your time and for your extraordinary dedication.", ja: "ご清聴いただき、そして皆様の素晴らしいご尽力に、心より感謝申し上げます。" }
  ];

  // --- TEDトーク「Grit: The power of passion and perseverance」（Angela Duckworth）実スピーチデータ ---
  const TED_SPEECH_DATA = [
    { en: "When I was 27 years old, I left a very demanding job in management consulting for a job that was even more demanding: teaching.", ja: "私が27歳のとき、経営コンサルティングという非常に過酷な仕事を辞めて、さらに過酷な教職に就きました。" },
    { en: "I went to teach seventh graders math in the New York City public schools.", ja: "ニューヨーク市の公立中学校で7年生（中学1年生）に数学を教え始めたのです。" },
    { en: "And like any teacher, I made quizzes and tests. I gave out homework assignments. When the work came back, I calculated grades.", ja: "そして他の教師と同じように、小テストや試験を作り、宿題を出し、成績を計算しました。" },
    { en: "What struck me was that IQ was not the only difference between my best and my worst students.", ja: "そこで私が強く衝撃を受けたのは、優秀な生徒とそうでない生徒の違いは、決してIQ（知能指数）だけではないということでした。" },
    { en: "Some of my strongest performers did not have stratospheric IQ scores. Some of my smartest kids weren't doing so well.", ja: "最高の結果を出す生徒の中には、際立って高いIQを持っていない子もいましたし、非常に頭の良いはずの子が伸び悩んでいたりもしました。" },
    { en: "And that got me thinking. The kinds of things you need to learn in seventh grade math, sure, they're hard: ratios, decimals, the area of a parallelogram.", ja: "そのことが私を深く考えさせました。7年生の数学で習う内容は確かに難しいものです。比率、小数、平行四辺形の面積などです。" },
    { en: "But these concepts are not impossible, and I was firmly convinced that every one of my students could learn the material if they worked hard and long enough.", ja: "しかし、これらの概念は決して習得不可能なものではなく、熱心に時間をかけて粘り強く取り組めば、どの生徒も必ず理解できると私は確信していました。" },
    { en: "After several more years of teaching, I came to the conclusion that what we need in education is a much better understanding of students and learning from a motivational perspective.", ja: "さらに数年間の教師生活を経て、私は一つの結論に達しました。教育に必要なのは、モチベーションの観点から生徒と学習をより深く理解することなのだと。" }
  ];

  // --- DOM要素 ---
  const dom = {
    transcriptContainer: document.getElementById('transcriptContainer'),
    committedStream: document.getElementById('committedStream'),
    welcomePlaceholder: document.getElementById('welcomePlaceholder'),
    liveActiveBlock: document.getElementById('liveActiveBlock'),
    activeEnLine: document.getElementById('activeEnLine'),
    activeJaLine: document.getElementById('activeJaLine'),

    liveIndicator: document.getElementById('liveIndicator'),
    speechStatus: document.getElementById('speechStatus'),
    volumeMeterWrapper: document.getElementById('volumeMeterWrapper'),
    volumeBar: document.getElementById('volumeBar'),
    translatingIndicator: document.getElementById('translatingIndicator'),
    toggleMicBtn: document.getElementById('toggleMicBtn'),
    micBtnText: document.getElementById('micBtnText'),

    // 通訳方向切り替え
    toggleDirectionBtn: document.getElementById('toggleDirectionBtn'),
    directionBadge: document.getElementById('directionBadge'),

    fontSizeBtns: document.querySelectorAll('.font-size-toggle button'),
    clearBtn: document.getElementById('clearBtn'),
    fullscreenBtn: document.getElementById('fullscreenBtn'),
    settingsBtn: document.getElementById('settingsBtn'),

    // クイックテキスト入力
    toggleTextInputBtn: document.getElementById('toggleTextInputBtn'),
    manualInputBar: document.getElementById('manualInputBar'),
    manualEnglishInput: document.getElementById('manualEnglishInput'),
    sendManualTextBtn: document.getElementById('sendManualTextBtn'),
    closeManualInputBtn: document.getElementById('closeManualInputBtn'),

    settingsModal: document.getElementById('settingsModal'),
    closeModalBtn: document.getElementById('closeModalBtn'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    deepgramApiKeyInput: document.getElementById('deepgramApiKeyInput'),
    deepgramKeyRow: document.getElementById('deepgramKeyRow'),
    sttEngineRadios: document.querySelectorAll('input[name="sttEngine"]'),
    geminiApiKeyInput: document.getElementById('geminiApiKeyInput'),
    geminiKeyRow: document.getElementById('geminiKeyRow'),
    demoActualSpeechBtn: document.getElementById('demoActualSpeechBtn'),
    demoTedSpeechBtn: document.getElementById('demoTedSpeechBtn'),
    modeRadios: document.querySelectorAll('input[name="interpreterMode"]')
  };

  // ==========================================================================
  // 初期化と設定
  // ==========================================================================
  function init() {
    loadSettings();
    applyFontSize(state.fontSize);
    setupEventListeners();
  }

  function updateDirectionUI() {
    if (!dom.toggleDirectionBtn || !dom.directionBadge) return;
    if (state.direction === 'ja-en') {
      dom.directionBadge.textContent = '🇯🇵 日 ➔ 🇺🇸 英';
      dom.toggleDirectionBtn.classList.add('ja-en');
      dom.toggleDirectionBtn.title = '通訳方向: 日本語（質問）➔ 英語（登壇者向け字幕）\nクリックで英日モードへ切替';
      if (dom.manualEnglishInput) {
        dom.manualEnglishInput.placeholder = '日本語の文章・質問を入力（または貼り付け）して Enter / 通訳...';
      }
    } else {
      dom.directionBadge.textContent = '🇺🇸 英 ➔ 🇯🇵 日';
      dom.toggleDirectionBtn.classList.remove('ja-en');
      dom.toggleDirectionBtn.title = '通訳方向: 英語スピーチ ➔ 日本語字幕（通常モード・日本語ノイズ自動スキップ）\nクリックで日英モードへ切替';
      if (dom.manualEnglishInput) {
        dom.manualEnglishInput.placeholder = '英語の文章を貼り付け（または入力）して Enter / 通訳ボタン...';
      }
    }
  }

  function loadSettings() {
    try {
      const savedDirection = localStorage.getItem('jci_direction');
      if (savedDirection) state.direction = savedDirection;

      const savedFontSize = localStorage.getItem('jci_font_size');
      if (savedFontSize) state.fontSize = savedFontSize;

      const savedSttEngine = localStorage.getItem('jci_stt_engine');
      if (savedSttEngine) state.sttEngine = savedSttEngine;

      const savedDgKey = localStorage.getItem('jci_deepgram_api_key');
      if (savedDgKey) state.deepgramApiKey = savedDgKey;

      const savedApiKey = localStorage.getItem('jci_gemini_api_key');
      if (savedApiKey) state.apiKey = savedApiKey;

      const savedMode = localStorage.getItem('jci_interpreter_mode');
      if (savedMode) {
        state.interpreterMode = savedMode;
      } else {
        state.interpreterMode = 'gemini-hybrid'; // デフォルトはGeminiハイブリッド
      }
    } catch (e) {
      console.warn('LocalStorage error:', e);
    }

    if (dom.deepgramApiKeyInput) dom.deepgramApiKeyInput.value = state.deepgramApiKey;
    if (dom.geminiApiKeyInput) dom.geminiApiKeyInput.value = state.apiKey;
    
    if (dom.sttEngineRadios) {
      dom.sttEngineRadios.forEach(radio => {
        radio.checked = (radio.value === state.sttEngine);
      });
    }

    if (dom.modeRadios) {
      dom.modeRadios.forEach(radio => {
        radio.checked = (radio.value === state.interpreterMode);
      });
    }

    updateSettingsVisibility();
  }

  function updateSettingsVisibility() {
    if (dom.deepgramKeyRow) {
      dom.deepgramKeyRow.style.display = (state.sttEngine === 'deepgram') ? 'block' : 'none';
    }
    if (dom.geminiKeyRow) {
      dom.geminiKeyRow.style.display = (state.interpreterMode === 'gemini-hybrid') ? 'block' : 'none';
    }
  }

  function saveSettings() {
    try {
      state.deepgramApiKey = dom.deepgramApiKeyInput ? dom.deepgramApiKeyInput.value.trim() : '';
      state.apiKey = dom.geminiApiKeyInput ? dom.geminiApiKeyInput.value.trim() : '';

      const selectedStt = document.querySelector('input[name="sttEngine"]:checked');
      if (selectedStt) {
        state.sttEngine = selectedStt.value;
      }

      const selectedRadio = document.querySelector('input[name="interpreterMode"]:checked');
      if (selectedRadio) {
        state.interpreterMode = selectedRadio.value;
      }

      localStorage.setItem('jci_stt_engine', state.sttEngine);
      localStorage.setItem('jci_deepgram_api_key', state.deepgramApiKey);
      localStorage.setItem('jci_gemini_api_key', state.apiKey);
      localStorage.setItem('jci_interpreter_mode', state.interpreterMode);
      updateSettingsVisibility();
      showNotification('設定を保存しました。');
    } catch (e) {
      console.warn('Save settings error:', e);
    }
  }

  // ==========================================================================
  // 通訳開始・停止マネージャー
  // ==========================================================================
  async function startInterpreting() {
    // DeepgramモードでAPIキーが未入力の場合は設定を促す
    if (state.sttEngine === 'deepgram' && !state.deepgramApiKey) {
      dom.settingsModal.style.display = 'flex';
      updateSettingsVisibility();
      showNotification('Deepgram API キーを設定してください（無料枠200時間・クレカ不要）', true);
      return;
    }

    state.isRecording = true;
    state.committedIndex = 0;
    state.currentAccumulatedText = '';
    updateUIStatus(true);
    hideWelcomePlaceholder();

    // 1. マイクストリーム取得（音量メーター & 音声認識共通）
    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      setupAudioVisualizer(state.mediaStream);
    } catch (err) {
      console.error('MediaStream error:', err);
      showNotification('マイクへのアクセスが許可されていません: ' + err.message, true);
      stopInterpreting();
      return;
    }

    // 2. 音声認識エンジンの起動
    if (state.sttEngine === 'deepgram') {
      startDeepgramStreaming();
    } else {
      startSpeechRecognition();
    }
  }

  function stopInterpreting() {
    state.isRecording = false;
    clearTimeout(state.recognitionRestartTimer);
    clearTimeout(state.speechDebounceTimer);
    state.committedIndex = 0;
    state.currentAccumulatedText = '';

    // Deepgram WebSocket & MediaRecorder 停止
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      try { state.mediaRecorder.stop(); } catch (e) {}
      state.mediaRecorder = null;
    }
    if (state.webSocket) {
      try {
        if (state.webSocket.readyState === WebSocket.OPEN) {
          state.webSocket.send(JSON.stringify({ type: 'stop' }));
        }
        state.webSocket.close();
      } catch (e) {}
      state.webSocket = null;
    }

    // Web Speech API 停止
    if (state.speechRecognition) {
      try {
        state.speechRecognition.onstart = null;
        state.speechRecognition.onresult = null;
        state.speechRecognition.onerror = null;
        state.speechRecognition.onend = null;
        state.speechRecognition.stop();
      } catch (e) {}
      state.speechRecognition = null;
    }

    // マイク解放
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(t => t.stop());
      state.mediaStream = null;
    }
    if (state.audioContext) {
      try { state.audioContext.close(); } catch (e) {}
      state.audioContext = null;
    }
    if (state.volumeAnimationId) {
      cancelAnimationFrame(state.volumeAnimationId);
    }

    dom.volumeMeterWrapper.style.display = 'none';
    dom.volumeBar.style.width = '0%';
    dom.liveActiveBlock.style.display = 'none';
    setTranslating(false);
    updateUIStatus(false);
  }

  // ==========================================================================
  // 【Deepgram Nova-2】WebSocket 生音声ストリーミング ＆ リアルタイム通訳
  // ==========================================================================
  function startDeepgramStreaming() {
    if (!state.isRecording || !state.mediaStream) return;

    dom.speechStatus.textContent = 'Deepgram AI 音声認識サーバーに接続中...';
    dom.speechStatus.className = 'status-text listening';

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);
    state.webSocket = ws;

    ws.onopen = () => {
      console.log(`[WebSocket] Connected to local server, mode: ${state.interpreterMode}, direction: ${state.direction}`);
      // Deepgramストリーミング開始要求を送信（directionを付与）
      ws.send(JSON.stringify({
        type: 'start',
        apiKey: state.deepgramApiKey,
        geminiApiKey: state.apiKey,
        interpreterMode: state.interpreterMode,
        direction: state.direction
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'deepgram_connected') {
          console.log(`[Deepgram] Backend connected (${msg.direction || state.direction}). Starting audio recorder...`);
          const directionText = state.direction === 'ja-en'
            ? '🎙️ Deepgram AI 待機中（日本語の質問を受信中）'
            : '🎙️ Deepgram AI 待機中（英語スピーチを受信中・日本語ノイズ自動スキップ）';
          dom.speechStatus.textContent = directionText;
          dom.speechStatus.className = 'status-text listening';

          // ★ Deepgramの接続確立を待ってから、WebMコンテナヘッダー付きで生音声を送信開始！
          if (state.isRecording) {
            startMediaRecordingToWs(ws);
          }
        } else if (msg.type === 'transcript') {
          // リアルタイム認識テキストのプレビュー表示
          if (msg.text) {
            dom.liveActiveBlock.style.display = 'flex';
            dom.activeEnLine.textContent = msg.text;
            dom.activeJaLine.textContent = state.direction === 'ja-en' ? '⚡ AIが英語へ翻訳中...' : '⚡ AIが日本語へ通訳中...';
            smartScrollToBottom();
          }
        } else if (msg.type === 'translation') {
          // 確定した翻訳が届いたら画面に美しいブロックとして積み上げ！
          const sourceText = msg.source || (state.direction === 'ja-en' ? msg.ja : msg.en);
          const targetText = msg.target || (state.direction === 'ja-en' ? msg.en : msg.ja);
          if (sourceText && targetText) {
            appendCommittedBlock(sourceText, targetText, msg.direction || state.direction);
            dom.liveActiveBlock.style.display = 'none';
            dom.activeEnLine.textContent = '';
            dom.activeJaLine.textContent = '';
            smartScrollToBottom();
          }
        } else if (msg.type === 'deepgram_disconnected') {
          console.warn('[Deepgram] Disconnected from Deepgram');
          if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
            try { state.mediaRecorder.stop(); } catch (e) {}
            state.mediaRecorder = null;
          }
        } else if (msg.type === 'error') {
          console.warn('[Server WS Error]:', msg.message);
          showNotification(msg.message, true);
          dom.speechStatus.textContent = '⚠️ ' + msg.message;
          dom.speechStatus.className = 'status-text';
        }
      } catch (err) {
        console.error('[WebSocket message parse error]:', err);
      }
    };

    ws.onerror = (err) => {
      console.error('[WebSocket error]:', err);
      showNotification('WebSocket接続エラーが発生しました。', true);
    };

    ws.onclose = () => {
      console.log('[WebSocket] Connection closed');
      if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        try { state.mediaRecorder.stop(); } catch (e) {}
        state.mediaRecorder = null;
      }
      if (state.isRecording) {
        dom.speechStatus.textContent = 'サーバーから切断されました。再接続中...';
        setTimeout(() => {
          if (state.isRecording && state.sttEngine === 'deepgram') {
            startDeepgramStreaming();
          }
        }, 1500);
      }
    };
  }

  // MediaRecorder によるマイク音声のストリーミング送信
  function startMediaRecordingToWs(ws) {
    if (!state.mediaStream) return;

    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      if (MediaRecorder.isTypeSupported('audio/webm')) {
        mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
        mimeType = 'audio/ogg;codecs=opus';
      } else {
        mimeType = '';
      }
    }

    try {
      const options = mimeType ? { mimeType } : {};
      const recorder = new MediaRecorder(state.mediaStream, options);
      state.mediaRecorder = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      // 250msごとに音声チャンクをリアルタイム送信
      recorder.start(250);
      console.log(`[MediaRecorder] Started streaming with mimeType: ${mimeType || 'default'}`);
    } catch (err) {
      console.error('[MediaRecorder error]:', err);
      showNotification('音声レコーダーの起動に失敗しました: ' + err.message, true);
    }
  }

  // ==========================================================================
  // 【スマート文章チャンク認識】単語のブツ切りを根絶し、意味のある文として通訳
  // ==========================================================================
  function startSpeechRecognition() {
    if (!state.isRecording) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('お使いのブラウザは音声認識をサポートしていません。Google Chromeをご利用ください。');
      stopInterpreting();
      return;
    }

    if (state.speechRecognition) {
      try {
        state.speechRecognition.onstart = null;
        state.speechRecognition.onresult = null;
        state.speechRecognition.onerror = null;
        state.speechRecognition.onend = null;
        state.speechRecognition.stop();
      } catch (e) {}
      state.speechRecognition = null;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = state.direction === 'ja-en' ? 'ja-JP' : 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      const langLabel = state.direction === 'ja-en' ? '日本語' : '英語';
      dom.speechStatus.textContent = state.interpreterMode === 'gemini-text'
        ? `Gemini AI 待機中（${langLabel}）`
        : `Google 翻訳 待機中（${langLabel}）`;
      dom.speechStatus.className = 'status-text listening';
    };

    recognition.onresult = (event) => {
      let finalSegment = '';
      let interimSegment = '';

      for (let i = state.committedIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalSegment += transcript + ' ';
        } else {
          interimSegment += transcript;
        }
      }

      const activeSpeechText = (finalSegment + interimSegment).trim();
      if (activeSpeechText) {
        state.currentAccumulatedText = activeSpeechText;
        dom.liveActiveBlock.style.display = 'flex';
        dom.activeEnLine.textContent = activeSpeechText;
        dom.activeJaLine.textContent = '間（ポーズ）または文の区切りで即座に通訳されます...';
        smartScrollToBottom();

        const words = activeSpeechText.split(/\s+/).filter(Boolean);

        // ★【TEDトーク対応】早口で連続して話しても、単語が8〜14単語程度に達したら自然に文として確定！
        if (words.length >= 10) {
          clearTimeout(state.speechDebounceTimer);
          state.committedIndex = event.results.length;
          triggerCommitSentence(activeSpeechText);
          return;
        }

        // 話者が話し終えて約 0.75 秒「間（沈黙）」を作ったら文を確定！
        clearTimeout(state.speechDebounceTimer);
        state.speechDebounceTimer = setTimeout(() => {
          if (state.currentAccumulatedText && state.currentAccumulatedText.trim().length > 1) {
            const wordsInText = state.currentAccumulatedText.trim().split(/\s+/).filter(Boolean);
            // 少なくとも2単語以上ある場合のみ確定（"kids" や "well" などの単独単語の誤爆を防止）
            if (wordsInText.length >= 2) {
              state.committedIndex = event.results.length;
              triggerCommitSentence(state.currentAccumulatedText);
            }
          }
        }, 750);
      }
    };

    recognition.onerror = (event) => {
      if (event.error !== 'no-speech') {
        console.warn('SpeechRecognition notice:', event.error);
      }
    };

    recognition.onend = () => {
      state.committedIndex = 0;
      if (state.isRecording) {
        state.recognitionRestartTimer = setTimeout(() => {
          if (state.isRecording) {
            startSpeechRecognition();
          }
        }, 120);
      }
    };

    state.speechRecognition = recognition;
    try {
      recognition.start();
    } catch (e) {
      console.warn('Recognition start exception, retrying in 250ms:', e);
      setTimeout(() => {
        if (state.isRecording) startSpeechRecognition();
      }, 250);
    }
  }

  // 文の確定と通訳トリガー
  function triggerCommitSentence(text) {
    const cleanText = text.trim();
    if (!cleanText || cleanText.length < 2) return;

    // 直前2秒以内の完全同一文のみ重複排除
    const now = Date.now();
    if (cleanText === state.lastProcessedSentence && (now - state.lastProcessedTime) < 2000) {
      return;
    }

    state.lastProcessedSentence = cleanText;
    state.lastProcessedTime = now;
    state.currentAccumulatedText = '';

    // 確定文の通訳を実行
    processFinalEnglishSentence(cleanText);
  }

  // 確定した英文を 爆速通訳して画面に積み上げる（タイムラグ0.05秒）
  // 確定した文章を 爆速通訳して画面に積み上げる（タイムラグ0.05秒）
  async function processFinalEnglishSentence(inputText) {
    if (!inputText || inputText.length < 2) return;

    setTranslating(true);
    dom.liveActiveBlock.style.display = 'flex';
    dom.activeEnLine.textContent = inputText;
    dom.activeJaLine.textContent = '✨ 通訳中...';
    smartScrollToBottom();

    let translatedResult = '';

    try {
      if (state.interpreterMode === 'gemini-text') {
        translatedResult = await Promise.race([
          translateWithGeminiText(inputText),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2500))
        ]);
      } else {
        translatedResult = await translateWithGoogleWeb(inputText);
      }
    } catch (err) {
      console.warn('Translation fallback to Google Translate:', err.message);
      try {
        translatedResult = await translateWithGoogleWeb(inputText);
      } catch (fbErr) {
        console.error('Fallback also failed:', fbErr);
        translatedResult = '（通訳完了）';
      }
    }

    if (translatedResult) {
      appendCommittedBlock(inputText, translatedResult, state.direction);
      state.recentContext.push({
        en: state.direction === 'ja-en' ? translatedResult : inputText,
        ja: state.direction === 'ja-en' ? inputText : translatedResult
      });
      if (state.recentContext.length > 3) state.recentContext.shift();

      dom.speechStatus.textContent = '✅ 通訳完了・次の発話をどうぞ';
      dom.speechStatus.className = 'status-text listening';
      setTimeout(() => {
        if (state.isRecording) {
          const langLabel = state.direction === 'ja-en' ? '日本語' : '英語';
          dom.speechStatus.textContent = state.interpreterMode === 'gemini-text'
            ? `Gemini AI 待機中（${langLabel}）`
            : `Google 翻訳 待機中（${langLabel}）`;
        }
      }, 1500);
    }

    setTranslating(false);
    dom.liveActiveBlock.style.display = 'none';
    dom.activeEnLine.textContent = '';
    dom.activeJaLine.textContent = '';
    smartScrollToBottom();
  }

  // 通訳 Web API（ローカルNode.jsプロキシ経由でGeminiハイブリッド or Google翻訳爆速）
  async function translateWithGoogleWeb(text) {
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          apiKey: state.apiKey,
          mode: state.interpreterMode,
          direction: state.direction
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data && (data.translated || data.ja)) {
          return (data.translated || data.ja).trim();
        }
      }
    } catch (e) {
      console.warn('/api/translate failed:', e);
    }
    return '';
  }

  // Gemini 2.5 Flash テキスト翻訳（ローカルNode.jsプロキシ経由）
  async function translateWithGeminiText(text) {
    try {
      const response = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: state.apiKey,
          text: text,
          context: state.recentContext
        })
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.ja) {
          return data.ja.trim();
        }
      }
    } catch (e) {
      console.warn('Local /api/gemini failed, trying fallback:', e);
    }
    return await translateWithGoogleWeb(text);
  }

  // ==========================================================================
  // マイク音量ビジュアライザー
  // ==========================================================================
  function setupAudioVisualizer(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      state.audioContext = new AudioCtx();
      const source = state.audioContext.createMediaStreamSource(stream);
      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 256;
      source.connect(state.analyser);

      dom.volumeMeterWrapper.style.display = 'inline-block';

      const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
      const updateVolume = () => {
        if (!state.isRecording) return;
        state.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        const volumePercent = Math.min(100, Math.round((average / 128) * 100));
        dom.volumeBar.style.width = `${volumePercent}%`;
        state.volumeAnimationId = requestAnimationFrame(updateVolume);
      };
      updateVolume();
    } catch (e) {
      console.warn('Audio visualizer error:', e);
    }
  }

  // ==========================================================================
  // 文章ブロックの確定追加 ＆ スムーズ自動追従スクロール
  // ==========================================================================
  function appendCommittedBlock(sourceText, targetText, direction = state.direction) {
    hideWelcomePlaceholder();

    const block = document.createElement('div');
    block.className = 'sentence-block ' + (direction === 'ja-en' ? 'mode-ja-en' : 'mode-en-ja');

    if (direction === 'ja-en') {
      // 日英モード: 日本語(質問原文)が上・小さめ、英語(翻訳)が下・特大（外国人登壇者向け）
      block.innerHTML = `
        <div class="sentence-ja">${escapeHtml(sourceText)}</div>
        <div class="sentence-en">${escapeHtml(targetText)}</div>
      `;
    } else {
      // 英日モード: 英語(原文)が上・小さめ、日本語(翻訳)が下・特大（日本人聴衆向け）
      block.innerHTML = `
        <div class="sentence-en">${escapeHtml(sourceText)}</div>
        <div class="sentence-ja">${escapeHtml(targetText)}</div>
      `;
    }

    dom.committedStream.appendChild(block);
    smartScrollToBottom();
  }

  // 画面がいっぱいになっても最新の文と入力プレビューへ常にスムーズにスクロール追従！
  function smartScrollToBottom() {
    requestAnimationFrame(() => {
      if (dom.transcriptContainer) {
        dom.transcriptContainer.scrollTo({
          top: dom.transcriptContainer.scrollHeight,
          behavior: 'smooth'
        });
      }
      if (dom.liveActiveBlock && dom.liveActiveBlock.style.display !== 'none') {
        dom.liveActiveBlock.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    });
  }

  function updateUIStatus(recording) {
    if (recording) {
      dom.toggleMicBtn.classList.add('recording');
      dom.micBtnText.textContent = '通訳停止';
      dom.liveIndicator.classList.add('active');
      dom.speechStatus.textContent = state.interpreterMode === 'gemini-text'
        ? 'Gemini AI 待機中（英語）'
        : 'Google 翻訳 待機中（超高速）';
      dom.speechStatus.className = 'status-text listening';
    } else {
      dom.toggleMicBtn.classList.remove('recording');
      dom.micBtnText.textContent = '通訳開始';
      dom.liveIndicator.classList.remove('active');
      dom.speechStatus.textContent = 'マイク停止中';
      dom.speechStatus.className = 'status-text';
    }
  }

  function setTranslating(active) {
    if (dom.translatingIndicator) {
      dom.translatingIndicator.style.display = active ? 'flex' : 'none';
    }
  }

  function hideWelcomePlaceholder() {
    if (dom.welcomePlaceholder) dom.welcomePlaceholder.style.display = 'none';
  }

  function showWelcomePlaceholder() {
    if (dom.welcomePlaceholder) dom.welcomePlaceholder.style.display = 'flex';
  }

  function applyFontSize(size) {
    state.fontSize = size;
    document.body.setAttribute('data-font-size', size);
    localStorage.setItem('jci_font_size', size);
    dom.fontSizeBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.size === size);
    });
    setTimeout(smartScrollToBottom, 100);
  }

  function showNotification(message, isError = false) {
    const existing = document.getElementById('appNotificationToast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'appNotificationToast';
    toast.style.position = 'fixed';
    toast.style.top = '70px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.backgroundColor = isError ? '#fee2e2' : '#f0fdf4';
    toast.style.color = isError ? '#b91c1c' : '#15803d';
    toast.style.border = `1px solid ${isError ? '#fca5a5' : '#86efac'}`;
    toast.style.padding = '10px 20px';
    toast.style.borderRadius = '8px';
    toast.style.fontSize = '14px';
    toast.style.fontWeight = 'bold';
    toast.style.zIndex = '9999';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
    toast.textContent = message;

    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast && toast.parentNode) toast.remove();
    }, 4500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ==========================================================================
  // 手動テキスト入力・貼り付けの処理
  // ==========================================================================
  function handleManualTextInput() {
    const input = dom.manualEnglishInput;
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    processFinalEnglishSentence(text);
  }

  // ==========================================================================
  // UIイベントハンドラー
  // ==========================================================================
  function setupEventListeners() {
    // 通訳開始/停止ボタン
    dom.toggleMicBtn.addEventListener('click', () => {
      if (state.isRecording) {
        stopInterpreting();
      } else {
        startInterpreting();
      }
    });

    // 通訳方向切り替えボタン（英日 / 日英）
    if (dom.toggleDirectionBtn) {
      dom.toggleDirectionBtn.addEventListener('click', () => {
        state.direction = state.direction === 'en-ja' ? 'ja-en' : 'en-ja';
        try { localStorage.setItem('jci_direction', state.direction); } catch (e) {}
        updateDirectionUI();

        const isJaEn = state.direction === 'ja-en';
        const msg = isJaEn
          ? '【質疑応答モード：日 ➔ 英】に切り替えました。日本語の質問を認識し、登壇者向けに英語訳を表示します。'
          : '【通常モード：英 ➔ 日】に切り替えました。英語スピーチを通訳し、日本語ノイズ・咳を自動スキップします。';
        showNotification(msg);

        // もし録音・通訳が進行中なら、安全に新言語ストリームへ再同期！
        if (state.isRecording) {
          showNotification(msg + '（通訳ストリームを切り替え中...）');
          stopInterpreting();
          setTimeout(() => {
            startInterpreting();
          }, 120);
        }
      });
    }

    // クイックテキスト入力バーの開閉
    if (dom.toggleTextInputBtn) {
      dom.toggleTextInputBtn.addEventListener('click', () => {
        const isHidden = dom.manualInputBar.style.display === 'none';
        dom.manualInputBar.style.display = isHidden ? 'flex' : 'none';
        if (isHidden && dom.manualEnglishInput) {
          dom.manualEnglishInput.focus();
        }
      });
    }

    if (dom.closeManualInputBtn) {
      dom.closeManualInputBtn.addEventListener('click', () => {
        dom.manualInputBar.style.display = 'none';
      });
    }

    // 手動入力の送信
    if (dom.sendManualTextBtn) {
      dom.sendManualTextBtn.addEventListener('click', handleManualTextInput);
    }
    if (dom.manualEnglishInput) {
      dom.manualEnglishInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleManualTextInput();
        }
      });
    }

    // 画面全体での Ctrl+V（貼り付け）検知
    window.addEventListener('paste', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
      }
      const pastedText = e.clipboardData ? e.clipboardData.getData('text') : '';
      if (pastedText && pastedText.trim().length > 2) {
        if (dom.manualInputBar) dom.manualInputBar.style.display = 'flex';
        if (dom.manualEnglishInput) dom.manualEnglishInput.value = pastedText.trim();
        processFinalEnglishSentence(pastedText.trim());
      }
    });

    // フォントサイズ切替
    dom.fontSizeBtns.forEach(btn => {
      btn.addEventListener('click', () => applyFontSize(btn.dataset.size));
    });

    // クリア
    dom.clearBtn.addEventListener('click', () => {
      if (confirm('表示中の字幕をすべて消去しますか？')) {
        dom.committedStream.innerHTML = '';
        dom.liveActiveBlock.style.display = 'none';
        state.recentContext = [];
        state.lastProcessedSentence = '';
        state.lastProcessedTime = 0;
        state.currentAccumulatedText = '';
        showWelcomePlaceholder();
      }
    });

    // 全画面
    dom.fullscreenBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
          alert(`全画面表示エラー: ${err.message}`);
        });
      } else {
        document.exitFullscreen();
      }
    });

    // 設定モーダル
    dom.settingsBtn.addEventListener('click', () => {
      if (dom.deepgramApiKeyInput) dom.deepgramApiKeyInput.value = state.deepgramApiKey;
      if (dom.geminiApiKeyInput) dom.geminiApiKeyInput.value = state.apiKey;
      if (dom.sttEngineRadios) {
        dom.sttEngineRadios.forEach(r => r.checked = (r.value === state.sttEngine));
      }
      if (dom.modeRadios) {
        dom.modeRadios.forEach(r => r.checked = (r.value === state.interpreterMode));
      }
      updateSettingsVisibility();
      dom.settingsModal.style.display = 'flex';
    });

    if (dom.sttEngineRadios) {
      dom.sttEngineRadios.forEach(r => {
        r.addEventListener('change', () => {
          const selected = document.querySelector('input[name="sttEngine"]:checked');
          if (selected) {
            state.sttEngine = selected.value;
            updateSettingsVisibility();
          }
        });
      });
    }

    if (dom.modeRadios) {
      dom.modeRadios.forEach(r => {
        r.addEventListener('change', () => {
          const selected = document.querySelector('input[name="interpreterMode"]:checked');
          if (selected) {
            state.interpreterMode = selected.value;
            updateSettingsVisibility();
          }
        });
      });
    }

    dom.closeModalBtn.addEventListener('click', () => dom.settingsModal.style.display = 'none');
    dom.settingsModal.addEventListener('click', (e) => {
      if (e.target === dom.settingsModal) dom.settingsModal.style.display = 'none';
    });

    dom.saveSettingsBtn.addEventListener('click', () => {
      saveSettings();
      dom.settingsModal.style.display = 'none';
    });

    // 本番スピーチ全文テスト再生
    dom.demoActualSpeechBtn.addEventListener('click', () => {
      runContinuousDemo(ACTUAL_SPEECH_DATA);
    });

    // TEDスピーチ「Grit」デモ再生
    if (dom.demoTedSpeechBtn) {
      dom.demoTedSpeechBtn.addEventListener('click', () => {
        runContinuousDemo(TED_SPEECH_DATA);
      });
    }
  }

  // デモ再生
  let isDemoRunning = false;
  async function runContinuousDemo(sentences) {
    if (isDemoRunning) return;
    isDemoRunning = true;
    dom.settingsModal.style.display = 'none';
    hideWelcomePlaceholder();

    for (let sIndex = 0; sIndex < sentences.length; sIndex++) {
      const item = sentences[sIndex];
      setTranslating(true);
      dom.liveActiveBlock.style.display = 'flex';
      dom.activeEnLine.textContent = item.en;
      dom.activeJaLine.textContent = '✨ 通訳中...';
      smartScrollToBottom();

      await sleep(350);

      appendCommittedBlock(item.en, item.ja);
      dom.liveActiveBlock.style.display = 'none';
      setTranslating(false);

      await sleep(900);
    }
    isDemoRunning = false;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  window.addEventListener('DOMContentLoaded', init);
})();
