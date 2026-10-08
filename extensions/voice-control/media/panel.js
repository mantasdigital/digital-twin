/* Voice Control panel. Runs inside the VS Code webview and as the standalone
   Voice Remote page (desktop tab, tablet, phone) served by the extension. */
;(function () {
  "use strict"

  const root = document.documentElement
  const mode = root.dataset.mode
  const token = root.dataset.token || ""
  const clientId = (mode === "webview" ? "panel-" : "remote-") + Math.random().toString(36).slice(2, 8)
  const $ = (id) => document.getElementById(id)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0
  const isIOS =
    /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  if (isTouch) root.classList.add("touch")

  // ------------------------------------------------------------ transport
  let post
  if (mode === "webview" && typeof acquireVsCodeApi === "function") {
    const vscode = acquireVsCodeApi()
    post = (msg) => vscode.postMessage(msg)
    window.addEventListener("message", (e) => onHost(e.data))
  } else {
    let ws
    const queue = []
    post = (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
      else queue.push(msg)
    }
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:"
      const base = location.pathname.replace(/\/[^/]*$/, "")
      ws = new WebSocket(`${proto}//${location.host}${base}/ws?t=${encodeURIComponent(token)}`)
      ws.onopen = () => {
        while (queue.length) ws.send(JSON.stringify(queue.shift()))
        post({ type: "ready", clientId, kind: "remote", ua: navigator.userAgent })
        setStatus("ok", "Connected")
      }
      ws.onmessage = (e) => {
        try {
          onHost(JSON.parse(e.data))
        } catch (err) {
          /* ignore */
        }
      }
      ws.onclose = () => {
        setStatus("", "Disconnected, retrying…")
        setTimeout(connect, 1500)
      }
    }
    connect()
  }

  // ------------------------------------------------------------ state
  const state = {
    sttMode: "browser",
    language: "",
    speakReplies: true,
    listening: {
      mode: "pushToTalk",
      wakePhrase: "Hey Twin",
      wakeAliases: [],
      endWord: "",
      pauseSeconds: 5,
      maxCommandSeconds: 60,
      autoStart: true,
      chime: true,
      preferOnDevice: true,
    },
    confirmation: { mode: "countdown", countdownSeconds: 5 },
    handsFreeOwner: null,
    busy: false,
    gotState: false,
  }
  let speakEnabled = true
  try {
    speakEnabled = localStorage.getItem("dtv.speak") !== "0"
  } catch (e) {
    /* ignore */
  }

  function setStatus(kind, text) {
    const dot = $("statusDot")
    dot.className = "dot" + (kind ? " " + kind : "")
    if (text) $("statusText").textContent = text
  }

  function onHost(msg) {
    if (!msg || typeof msg !== "object") return
    switch (msg.type) {
      case "state":
        applyState(msg)
        break
      case "status":
        state.busy = msg.phase !== "idle" && msg.phase !== "confirm"
        $("mic").classList.toggle("busy", state.busy && cap.phase !== "capture")
        if (msg.phase === "idle") idleStatus(msg.text)
        else if (msg.phase === "confirm") setStatus("busy", msg.text || "Confirm?")
        else setStatus("busy", msg.text || msg.phase)
        break
      case "transcript":
        showHeard(msg.text, "")
        break
      case "actions":
        showActions(msg)
        break
      case "pendingResolved":
        stopCountdown()
        cancelWindow(false)
        break
      case "results":
        showResults(msg.items || [])
        break
      case "error":
        showError(msg.message)
        break
      case "record":
        if (msg.start && cap.phase !== "capture") startCapture("tap")
        else if (!msg.start && cap.phase === "capture") finishCapture("tap")
        break
      case "handsFree":
        if (msg.start && !hf.armed && mode === "webview") arm()
        else if (!msg.start && hf.armed) disarm()
        break
    }
  }

  function idleStatus(text) {
    if (hf.armed) setStatus("armed", text || `Listening for "${state.listening.wakePhrase}"`)
    else setStatus("ok", text || "Ready")
  }

  function applyState(s) {
    const first = !state.gotState
    state.gotState = true
    state.sttMode = s.sttMode
    state.language = s.language || ""
    state.speakReplies = s.speakReplies !== false
    state.listening = Object.assign(state.listening, s.listening || {})
    state.confirmation = Object.assign(state.confirmation, s.confirmation || {})
    state.handsFreeOwner = s.handsFreeOwner || null
    const setup = s.setup || {}

    if (s.enabled === false) {
      setStatus("", "Voice Control is turned off in settings")
      $("mic").disabled = true
      return
    }
    $("mic").disabled = false

    // Setup card
    $("setup").classList.toggle("hidden", Boolean(setup.complete && setup.claudeLogin))
    $("stepAnthropic").classList.toggle("done", Boolean(setup.brainReady))
    $("brainDesc").textContent = setup.brainReady
      ? s.brainActive === "claudeAccount"
        ? "using your Claude account (terminal login)"
        : "using an Anthropic API key"
      : s.brain === "claudeAccount"
        ? "Claude account chosen: run claude in a terminal and log in"
        : "Claude account (like the terminal) or an API key"
    $("stepListening").classList.toggle("done", Boolean(setup.listeningChosen))
    $("stepClaude").classList.toggle("done", Boolean(setup.claudeLogin))
    $("stepSpeech").classList.toggle("done", Boolean(setup.speechKey))
    const speechDesc = {
      browser: "browser built-in (free)",
      openai: "OpenAI gpt-4o-transcribe",
      deepgram: "Deepgram Nova-3",
    }
    $("speechDesc").textContent = speechDesc[s.provider] || s.provider
    $("listeningDesc").textContent =
      state.listening.mode === "wakeWord"
        ? `hands-free, wake phrase "${state.listening.wakePhrase}"`
        : "push-to-talk (tap or shortcut)"
    $("btnSpeechKey").classList.toggle("hidden", s.provider === "browser")
    $("setupHint").textContent =
      mode === "remote" ? "Keys and choices are entered in the IDE window; this page follows them." : ""
    $("modelInfo").textContent = `${s.model} · ${s.provider}`
    renderTerminals(s.terminals || [])
    fillSettings(s)

    // Hands-free visibility / ownership
    const wake = state.listening.mode === "wakeWord"
    $("btnEar").classList.toggle("hidden", !wake || !SR)
    if (hf.armed && state.handsFreeOwner && state.handsFreeOwner !== clientId) disarm(true) // another device took over
    if (!wake && hf.armed) disarm()
    if (wake && first && state.listening.autoStart && mode === "webview" && !state.handsFreeOwner && setup.brainReady)
      arm()
    if (hf.armed) startWakeIfNeeded()

    $("hint").textContent = wake
      ? `Say "${state.listening.wakePhrase}", then your command. Or tap to talk.${state.listening.endWord ? ` End with "${state.listening.endWord}" or a ${state.listening.pauseSeconds}s pause.` : ` A ${state.listening.pauseSeconds}s pause ends it.`}`
      : `Tap to talk. Stop with a ${state.listening.pauseSeconds}s pause${state.listening.endWord ? `, the word "${state.listening.endWord}"` : ""} or another tap.`
    if (!setup.brainReady) setStatus("", "Needs setup")
    else if (cap.phase !== "capture" && !state.busy) idleStatus()
    $("btnSpeak").classList.toggle("off", !speakEnabled)
    $("btnEar").classList.toggle("on", hf.armed)
  }

  function renderTerminals(list) {
    const ul = $("terminals")
    ul.innerHTML = ""
    if (!list.length) {
      const li = document.createElement("li")
      li.className = "muted"
      li.textContent = 'none open — say "open a terminal"'
      ul.appendChild(li)
      return
    }
    for (const t of list) {
      const li = document.createElement("li")
      li.textContent = `${t.index}: ${t.name}`
      if (t.active) li.classList.add("active")
      ul.appendChild(li)
    }
  }

  // ------------------------------------------------------------ settings editor
  let fillingSettings = false
  function fillSettings(s) {
    fillingSettings = true
    const values = {
      brain: s.brain,
      "listening.mode": state.listening.mode,
      "listening.wakePhrase": state.listening.wakePhrase,
      "listening.endWord": state.listening.endWord,
      "listening.pauseSeconds": state.listening.pauseSeconds,
      "listening.autoStart": state.listening.autoStart,
      "listening.chime": state.listening.chime,
      "confirmation.mode": state.confirmation.mode,
      "confirmation.countdownSeconds": state.confirmation.countdownSeconds,
      "speech.provider": s.provider,
      "speech.language": state.language,
      speakReplies: state.speakReplies,
    }
    for (const el of document.querySelectorAll("[data-setting]")) {
      const v = values[el.dataset.setting]
      if (v === undefined) continue
      if (el.type === "checkbox") el.checked = Boolean(v)
      else if (document.activeElement !== el) el.value = String(v)
    }
    fillingSettings = false
  }
  for (const el of document.querySelectorAll("[data-setting]")) {
    el.addEventListener("change", () => {
      if (fillingSettings) return
      let value = el.type === "checkbox" ? el.checked : el.value
      if (el.type === "number") value = parseFloat(value)
      post({ type: "setSetting", key: el.dataset.setting, value })
    })
  }

  // ------------------------------------------------------------ heard / actions UI
  function showHeard(finalText, interim) {
    const el = $("heard")
    el.innerHTML = ""
    if (!finalText && !interim) {
      el.textContent = "…"
      el.className = "transcript muted"
      return
    }
    el.className = "transcript"
    el.appendChild(document.createTextNode(finalText || ""))
    if (interim) {
      const i = document.createElement("span")
      i.className = "interim"
      i.textContent = (finalText ? " " : "") + interim
      el.appendChild(i)
    }
  }

  let countdownTimer = null
  function showActions(msg) {
    const items = msg.items || []
    const ul = $("actions")
    ul.innerHTML = ""
    for (const it of items) {
      const li = document.createElement("li")
      li.textContent = it.label
      if (it.dangerous) li.classList.add("dangerous")
      ul.appendChild(li)
    }
    if (msg.heard) showHeard(msg.heard, "")
    $("confirmRow").classList.toggle("hidden", !msg.needsConfirm)
    const reply = $("reply")
    reply.textContent = msg.say || ""
    reply.classList.toggle("hidden", !msg.say)
    $("actionsCard").classList.toggle("hidden", !items.length && !msg.say)
    stopCountdown()
    if (msg.countdown > 0) startCountdown(msg.countdown)
    if (msg.say) speak(msg.say)
    else if (msg.needsConfirm)
      speak(items.some((i) => i.dangerous) ? "This looks destructive. Say yes to confirm." : "Say yes to run this.")
    else if (msg.countdown > 0 && items.length) speak(summarize(items))
    if (msg.needsConfirm || msg.countdown > 0) cancelWindow(true)
  }

  function summarize(items) {
    const first = items[0].label.replace(/^(Run|Type) in .*?: /, "Running ")
    return items.length > 1 ? `${first}, plus ${items.length - 1} more.` : first + "."
  }

  function startCountdown(seconds) {
    const row = $("countdownRow")
    const bar = $("countdownBar")
    row.classList.remove("hidden")
    const start = Date.now()
    bar.style.width = "100%"
    countdownTimer = setInterval(() => {
      const left = Math.max(0, seconds * 1000 - (Date.now() - start))
      bar.style.width = (left / (seconds * 1000)) * 100 + "%"
      if (left <= 0) stopCountdown()
    }, 100)
  }
  function stopCountdown() {
    clearInterval(countdownTimer)
    countdownTimer = null
    $("countdownRow").classList.add("hidden")
  }

  function showResults(items) {
    const ul = $("actions")
    for (const text of items) {
      const li = document.createElement("li")
      li.className = "result"
      li.textContent = "✓ " + text
      ul.appendChild(li)
    }
    $("actionsCard").classList.remove("hidden")
  }

  function showError(message) {
    const el = $("micError")
    el.textContent = message
    el.classList.remove("hidden")
    setStatus("", "Error")
    clearTimeout(showError.t)
    showError.t = setTimeout(() => el.classList.add("hidden"), 9000)
  }

  // ------------------------------------------------------------ sound
  let audioCtx = null
  let ttsSpeaking = false
  let lastTtsEnd = 0
  function unlockAudio() {
    // iOS/Android need a user gesture before sound; do it on the first tap.
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      if (audioCtx.state === "suspended") audioCtx.resume()
      if ("speechSynthesis" in window && !unlockAudio.done) {
        const u = new SpeechSynthesisUtterance("")
        u.volume = 0
        window.speechSynthesis.speak(u)
      }
      unlockAudio.done = true
    } catch (e) {
      /* ignore */
    }
  }
  function chime(kind) {
    if (!state.listening.chime || !audioCtx) return
    try {
      const o = audioCtx.createOscillator()
      const g = audioCtx.createGain()
      o.type = "sine"
      o.frequency.value = kind === "wake" ? 880 : kind === "done" ? 660 : 440
      g.gain.value = 0.0001
      o.connect(g).connect(audioCtx.destination)
      const t = audioCtx.currentTime
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
      o.start(t)
      o.stop(t + 0.2)
    } catch (e) {
      /* ignore */
    }
  }
  function speak(text) {
    if (!speakEnabled || !state.speakReplies || !("speechSynthesis" in window)) return
    try {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      if (state.language) u.lang = state.language
      u.rate = 1.05
      u.onstart = () => {
        ttsSpeaking = true
      }
      u.onend = u.onerror = () => {
        ttsSpeaking = false
        lastTtsEnd = Date.now()
      }
      window.speechSynthesis.speak(u)
    } catch (e) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ text helpers
  function norm(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  }
  function levenshtein(a, b) {
    const m = a.length
    const n = b.length
    if (!m) return n
    if (!n) return m
    let prev = Array.from({ length: n + 1 }, (_, i) => i)
    for (let i = 1; i <= m; i++) {
      const cur = [i]
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      }
      prev = cur
    }
    return prev[n]
  }
  /** Find the wake phrase (or an alias) in text; return the text after it, or null. */
  function matchWake(text) {
    const t = norm(text)
    if (!t) return null
    const phrases = [state.listening.wakePhrase]
      .concat(state.listening.wakeAliases || [])
      .map(norm)
      .filter(Boolean)
    const words = t.split(" ")
    for (const phrase of phrases) {
      const pw = phrase.split(" ").length
      const tol = Math.max(1, Math.floor(phrase.replace(/ /g, "").length / 4))
      for (let i = 0; i + pw <= words.length; i++) {
        const span = words.slice(i, i + pw).join(" ")
        if (span === phrase || levenshtein(span.replace(/ /g, ""), phrase.replace(/ /g, "")) <= tol) {
          return words.slice(i + pw).join(" ")
        }
      }
    }
    return null
  }
  function endsWithEndWord(text) {
    const ew = norm(state.listening.endWord)
    if (!ew) return false
    const t = norm(text)
    return t === ew || t.endsWith(" " + ew)
  }
  function stripEndWord(text) {
    const ew = norm(state.listening.endWord)
    if (!ew) return text.trim()
    const t = text.trim()
    const re = new RegExp(
      "[\\s,.!?]*\\b" + ew.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + "\\b[\\s.!?,]*$",
      "i",
    )
    return t.replace(re, "").trim()
  }
  const STOP_WORDS = /^(stop|pause|disable) (listening|hands ?free)|^go to sleep\b|^sleep now\b/i
  const CANCEL_WORDS = /^(no|nope|cancel|stop|abort|never ?mind|don'?t|wait)\b/i
  const YES_WORDS = /^(yes|yeah|yep|yup|sure|confirm|confirmed|do it|run it|go ahead|go|ok|okay|proceed|run now)\b/i

  // ------------------------------------------------------------ recognizer (wake word + command text)
  const hf = { armed: false, rec: null, restartTimer: null, stopping: false, backoff: 300, onDevice: false }
  const cap = {
    phase: "idle",
    source: null,
    buffer: "",
    interim: "",
    silenceTimer: null,
    maxTimer: null,
    recorder: null,
    stream: null,
    vad: null,
    cancelWin: false,
  }

  // Decide ONCE whether on-device recognition is available (Chrome 139+); the
  // result is cached so starting a recognizer never has to await anything.
  // An await inside startRecognizer let a second instance be created while
  // the first was still being configured; Chrome then aborts the other one,
  // and the two kept aborting each other forever ("recognizer error: aborted").
  let onDeviceDecision = null // null = unknown, true/false once probed
  function probeOnDevice() {
    if (onDeviceDecision !== null || !SR || !SR.available || !state.listening.preferOnDevice) return
    onDeviceDecision = false
    const langs = [state.language || navigator.language || "en-US"]
    SR.available({ langs, processLocally: true })
      .then((status) => {
        if (status === "available") onDeviceDecision = true
        else if (status === "downloadable" && SR.install) SR.install({ langs, processLocally: true }).catch(() => {})
      })
      .catch(() => {})
  }

  /** One continuous recognizer serves wake detection, command text and cancel words. */
  function startRecognizer() {
    if (!SR || hf.rec) return
    const rec = new SR()
    hf.rec = rec // reserve the slot synchronously: only one recognizer may ever exist
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    if (state.language) rec.lang = state.language
    if (hf.armed && onDeviceDecision === true) {
      try {
        rec.processLocally = true
      } catch (e) {
        /* ignore */
      }
    }
    rec.onresult = onRecResult
    rec.onerror = (e) => {
      if (hf.rec !== rec) return // stale instance
      const err = e.error
      if (err !== "no-speech") post({ type: "log", text: `recognizer error: ${err} ${e.message || ""}` })
      if (err === "aborted") {
        const now = Date.now()
        // Aborted within a second of starting, without ever hearing anything:
        // the browser's speech backend is not there (Comet, Brave, ...).
        if (!hf.gotResult && now - (hf.lastStart || 0) < 1500) {
          hf.earlyAborts = (hf.earlyAborts || 0) + 1
          if (hf.earlyAborts >= 3) {
            hf.earlyAborts = 0
            showError(
              "This browser has no working built-in speech service (Perplexity Comet, Brave and similar strip it). Use Chrome or Edge, or switch the Speech engine to OpenAI or Deepgram in ⚙ Settings, which records audio instead and works in any browser.",
            )
            recognizerFatal(true)
            return
          }
        }
        hf.aborts = (hf.aborts || []).filter((t) => now - t < 10000)
        hf.aborts.push(now)
        if (hf.aborts.length >= 4) {
          hf.aborts = []
          showError(
            "Speech recognition keeps being interrupted. Close other tabs or apps that use the microphone (including a second Voice panel), then tap the ear again.",
          )
          recognizerFatal()
          return
        }
        hf.backoff = Math.max(hf.backoff, 800)
      }
      if (err === "not-allowed" || err === "service-not-allowed") {
        micFailure({ name: "NotAllowedError", message: e.message || err })
        recognizerFatal()
        return
      }
      if (err === "audio-capture") {
        micFailure({ name: "NotFoundError", message: "no microphone input" })
        recognizerFatal()
        return
      }
      if (err === "language-not-supported") {
        hf.rec = null
        showError(
          `Speech recognition does not support the language "${state.language}". Clear or change Language in Settings.`,
        )
        disarm()
        if (cap.phase === "capture") abortCapture()
        return
      }
      if (err === "network") {
        // Chromium forks that strip Google services (Brave, Comet, ...) report
        // "network" immediately and forever. Two in a row means: give up and say so.
        hf.netErrors = (hf.netErrors || 0) + 1
        hf.backoff = Math.min(8000, hf.backoff * 2)
        if (hf.netErrors >= 2) {
          hf.netErrors = 0
          showError(
            "This browser has no working built-in speech service (Perplexity Comet, Brave and similar strip it). Use Chrome or Edge, or switch the Speech engine to OpenAI or Deepgram in ⚙ Settings, which records audio instead and works in any browser.",
          )
          recognizerFatal(true)
          return
        }
      }
      // no-speech / aborted: onend follows and restarts if needed
    }
    rec.onend = () => {
      if (hf.rec !== rec) return // stale instance
      hf.rec = null
      if (hf.stopping) return
      if (hf.armed || cap.phase === "capture" || cap.cancelWin) {
        clearTimeout(hf.restartTimer)
        hf.restartTimer = setTimeout(() => {
          hf.backoff = Math.min(hf.backoff, 2000)
          startRecognizer()
        }, hf.backoff)
      }
    }
    try {
      rec.start()
      hf.lastStart = Date.now()
      hf.gotResult = false
      hf.backoff = Math.max(300, Math.min(hf.backoff, 2000))
    } catch (err) {
      hf.rec = null
      if (!/already started/i.test(String(err && err.message))) micFailure(err)
    }
  }
  function stopRecognizer() {
    hf.stopping = true
    clearTimeout(hf.restartTimer)
    try {
      hf.rec && hf.rec.stop()
    } catch (e) {
      /* ignore */
    }
    hf.rec = null
    setTimeout(() => {
      hf.stopping = false
    }, 50)
  }
  function startWakeIfNeeded() {
    if (hf.recognizerBroken) return // browser speech service unusable; user can retry via the ear button
    if (Date.now() < (hf.cooldownUntil || 0)) return // a fatal error just happened; don't thrash
    if ((hf.armed || cap.phase === "capture" || cap.cancelWin) && !hf.rec) startRecognizer()
    else if (!hf.armed && cap.phase !== "capture" && !cap.cancelWin && hf.rec) stopRecognizer()
  }

  /** Stop everything that could restart the recognizer and back off for a while. */
  function recognizerFatal(permanent) {
    hf.rec = null
    hf.cooldownUntil = Date.now() + 15000
    if (permanent) hf.recognizerBroken = true // until the user taps the ear again
    cap.cancelWin = false
    disarm()
    // In record mode the recognizer is only a helper (end word / timing); the
    // audio capture and its energy-based pause detection carry on without it.
    if (cap.phase === "capture" && state.sttMode !== "record") abortCapture()
  }

  function onRecResult(e) {
    hf.netErrors = 0
    hf.earlyAborts = 0
    hf.gotResult = true
    if (ttsSpeaking || Date.now() - lastTtsEnd < 800) return // never react to our own voice
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      const text = r[0].transcript
      const isFinal = r.isFinal
      if (cap.cancelWin) {
        if (isFinal) {
          const t = norm(text)
          if (CANCEL_WORDS.test(t)) post({ type: "confirm", accept: false })
          else if (YES_WORDS.test(t)) post({ type: "confirm", accept: true })
        }
        continue
      }
      if (cap.phase === "capture") {
        // The same utterance keeps updating with the wake phrase in front of
        // it ("hey twin open a terminal"); keep only what follows the phrase.
        const afterWake = cap.source === "wake" ? matchWake(text) : null
        const spoken = afterWake !== null ? afterWake : text
        if (isFinal) {
          cap.buffer = (cap.buffer + " " + spoken).trim()
          cap.interim = ""
        } else cap.interim = spoken
        showHeard(cap.buffer, cap.interim)
        resetSilence()
        const whole = (cap.buffer + " " + cap.interim).trim()
        if (STOP_WORDS.test(norm(whole))) {
          abortCapture()
          disarm()
          speak("Okay, I stopped listening.")
          return
        }
        if (endsWithEndWord(whole) && (isFinal || cap.interim)) finishCapture("endword")
        continue
      }
      if (hf.armed) {
        const after = matchWake(text)
        if (after !== null) {
          // Prefill as interim either way; the final result for this utterance
          // lands in the capture branch above and becomes the buffer.
          startCapture("wake", "", after)
        }
      }
    }
  }

  // ------------------------------------------------------------ capture (one command)
  function startCapture(source, prefill, interim) {
    if (cap.phase === "capture") return
    if (source === "tap") hf.cooldownUntil = 0
    unlockAudio()
    $("micError").classList.add("hidden")
    cap.phase = "capture"
    cap.source = source
    cap.buffer = prefill || ""
    cap.interim = interim || ""
    showHeard(cap.buffer, cap.interim)
    $("mic").classList.add("recording")
    $("mic").classList.remove("busy")
    setStatus("recording", source === "wake" ? "Yes? Listening…" : "Listening… tap, pause or end word to send")
    post({ type: "recording", active: true })
    if (source === "wake") chime("wake")
    clearTimeout(cap.maxTimer)
    cap.maxTimer = setTimeout(() => finishCapture("max"), state.listening.maxCommandSeconds * 1000)
    resetSilence()
    if (state.sttMode === "record") startRecorder()
    else if (hf.recognizerBroken) {
      showError(
        "This browser has no working built-in speech service (Perplexity Comet, Brave and similar strip it). Use Chrome or Edge, or switch the Speech engine to OpenAI or Deepgram in ⚙ Settings, which records audio instead and works in any browser.",
      )
      abortCapture()
      return
    } else if (!SR) {
      showError("This browser has no speech recognition. Switch the speech engine to OpenAI or Deepgram in Settings.")
      abortCapture()
      return
    }
    if (SR) startWakeIfNeeded() // recognizer provides text / end word / pause timing
  }

  function resetSilence() {
    clearTimeout(cap.silenceTimer)
    if (cap.phase !== "capture") return
    cap.silenceTimer = setTimeout(() => finishCapture("pause"), state.listening.pauseSeconds * 1000)
  }

  function finishCapture(reason) {
    if (cap.phase !== "capture") return
    cap.phase = "idle"
    clearTimeout(cap.silenceTimer)
    clearTimeout(cap.maxTimer)
    const text = stripEndWord((cap.buffer + " " + cap.interim).trim())
    cap.buffer = ""
    cap.interim = ""
    $("mic").classList.remove("recording")
    post({ type: "recording", active: false })
    if (state.sttMode === "record" && cap.recorder) {
      stopRecorder(text) // sends audio (browser text goes along as a fallback hint)
    } else if (text) {
      chime("done")
      showHeard(text, "")
      setStatus("busy", "Sending…")
      post({ type: "transcript", text })
    } else {
      idleStatus(reason === "wake" ? "" : "Didn't catch that")
    }
    startWakeIfNeeded()
  }

  function abortCapture() {
    if (cap.phase !== "capture") return
    cap.phase = "idle"
    clearTimeout(cap.silenceTimer)
    clearTimeout(cap.maxTimer)
    cap.buffer = ""
    cap.interim = ""
    $("mic").classList.remove("recording")
    post({ type: "recording", active: false })
    if (cap.recorder) {
      cap.recorder.onstop = null
      try {
        cap.recorder.stop()
      } catch (e) {
        /* ignore */
      }
      cap.recorder = null
    }
    stopVad()
    if (cap.stream) cap.stream.getTracks().forEach((t) => t.stop())
    cap.stream = null
    idleStatus()
    startWakeIfNeeded()
  }

  function cancelWindow(on) {
    cap.cancelWin = Boolean(on) && Boolean(SR)
    startWakeIfNeeded()
  }

  // ------------------------------------------------------------ hands-free arm/disarm
  function arm() {
    hf.cooldownUntil = 0
    hf.recognizerBroken = false
    hf.earlyAborts = 0
    probeOnDevice()
    if (!SR) {
      showError("Hands-free needs browser speech recognition (Chrome, Edge or Safari).")
      return
    }
    unlockAudio()
    hf.armed = true
    $("btnEar").classList.add("on")
    post({ type: "handsFree", active: true, clientId })
    startWakeIfNeeded()
    idleStatus()
  }
  function disarm(silent) {
    const was = hf.armed
    hf.armed = false
    $("btnEar").classList.remove("on")
    if (was && !silent) post({ type: "handsFree", active: false, clientId })
    startWakeIfNeeded()
    if (cap.phase !== "capture") idleStatus()
  }

  // ------------------------------------------------------------ recorder (high-quality STT path)
  function micFailure(err) {
    const name = err && err.name
    let msg = "Microphone unavailable: " + (err && err.message ? err.message : name || err)
    if (name === "NotAllowedError" || name === "SecurityError" || /permission|denied|not allowed/i.test(msg)) {
      msg =
        mode === "webview"
          ? 'Microphone is blocked inside this panel. Allow it in the browser\'s site settings, or use "Open on phone / tablet / new tab" below.'
          : "Microphone permission denied. Allow it in your browser's site settings and reload."
    } else if (name === "NotFoundError") msg = "No microphone found."
    showError(msg)
    post({ type: "log", text: `mic failure: ${name} ${err && err.message}` })
  }

  async function startRecorder() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      showError(
        'Audio recording is not available here. Use "Open on phone / tablet / new tab", or switch the speech engine to Browser.',
      )
      abortCapture()
      return
    }
    try {
      cap.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
    } catch (err) {
      micFailure(err)
      abortCapture()
      return
    }
    if (cap.phase !== "capture") {
      cap.stream.getTracks().forEach((t) => t.stop())
      return
    }
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    )
    const chunks = []
    try {
      cap.recorder = new MediaRecorder(cap.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined)
    } catch (err) {
      micFailure(err)
      abortCapture()
      return
    }
    cap.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data)
    }
    cap.recorder.onstop = async () => {
      const rec = cap.recorder
      cap.recorder = null
      stopVad()
      if (cap.stream) cap.stream.getTracks().forEach((t) => t.stop())
      cap.stream = null
      const blob = new Blob(chunks, { type: (rec && rec.mimeType) || mime || "audio/webm" })
      if (blob.size < 1000) {
        idleStatus("Too short")
        return
      }
      chime("done")
      setStatus("busy", "Uploading…")
      const data = await blobToBase64(blob)
      post({ type: "audio", mime: blob.type, data, hint: cap.lastHint || "" })
    }
    cap.recorder.start(250)
    startVad(cap.stream) // energy-based pause detection, works without SpeechRecognition (Firefox)
  }
  function stopRecorder(hintText) {
    cap.lastHint = hintText || ""
    try {
      if (cap.recorder && cap.recorder.state !== "inactive") cap.recorder.stop()
    } catch (e) {
      /* ignore */
    }
  }

  function startVad(stream) {
    if (!audioCtx) return
    try {
      const src = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 1024
      src.connect(analyser)
      const buf = new Uint8Array(analyser.fftSize)
      let spoke = false
      cap.vad = setInterval(() => {
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / buf.length)
        if (rms > 0.03) {
          spoke = true
          resetSilence()
        } else if (!spoke) resetSilence() // keep waiting while the user has not started yet
      }, 150)
      cap.vadNodes = { src, analyser }
    } catch (e) {
      /* ignore */
    }
  }
  function stopVad() {
    clearInterval(cap.vad)
    cap.vad = null
    try {
      cap.vadNodes && cap.vadNodes.src.disconnect()
    } catch (e) {
      /* ignore */
    }
    cap.vadNodes = null
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "")
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  // ------------------------------------------------------------ UI wiring
  $("mic").addEventListener("click", () => {
    unlockAudio()
    if (cap.phase === "capture") finishCapture("tap")
    else startCapture("tap")
  })
  $("btnEar").addEventListener("click", () => (hf.armed ? disarm() : arm()))
  $("btnConfirm").addEventListener("click", () => post({ type: "confirm", accept: true }))
  $("btnCancel").addEventListener("click", () => post({ type: "confirm", accept: false }))
  $("btnRunNow").addEventListener("click", () => post({ type: "confirm", accept: true }))
  $("btnCancelCountdown").addEventListener("click", () => post({ type: "confirm", accept: false }))
  $("btnRemote").addEventListener("click", (e) => {
    e.preventDefault()
    post({ type: "openRemote" })
  })
  $("btnSettingsToggle").addEventListener("click", () => $("settingsCard").classList.toggle("hidden"))
  $("btnAllSettings").addEventListener("click", () => post({ type: "openSettings" }))
  $("btnSpeak").addEventListener("click", () => {
    speakEnabled = !speakEnabled
    try {
      localStorage.setItem("dtv.speak", speakEnabled ? "1" : "0")
    } catch (e) {
      /* ignore */
    }
    $("btnSpeak").classList.toggle("off", !speakEnabled)
  })
  for (const btn of document.querySelectorAll("[data-setup]")) {
    btn.addEventListener("click", () => post({ type: "setup", action: btn.dataset.setup }))
  }
  $("textForm").addEventListener("submit", (e) => {
    e.preventDefault()
    const input = $("textInput")
    const text = input.value.trim()
    if (!text) return
    input.value = ""
    showHeard(text, "")
    post({ type: "text", text })
  })
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault()
      if (e.altKey) hf.armed ? disarm() : arm()
      else cap.phase === "capture" ? finishCapture("tap") : startCapture("tap")
    }
  })
  // iOS Safari stops recognition when the page is hidden; resume when it returns.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") startWakeIfNeeded()
  })
  window.addEventListener("pagehide", () => {
    if (hf.armed) disarm()
  })
  if (isIOS) $("hint").textContent += " On iPhone/iPad keep this page open; the screen lock stops the microphone."

  if (mode === "webview") post({ type: "ready", clientId, kind: "webview", ua: navigator.userAgent })
  post({
    type: "log",
    text: `panel booted (${mode}; speechRecognition=${Boolean(SR)}; mediaDevices=${Boolean(navigator.mediaDevices)})`,
  })
})()
