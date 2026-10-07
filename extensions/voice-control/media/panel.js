/* Voice Control panel. Runs both inside the VS Code webview and as a standalone
   page served by the extension (opened through code-server's port proxy). */
;(function () {
  "use strict"

  const mode = document.documentElement.dataset.mode
  const $ = (id) => document.getElementById(id)

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
      ws = new WebSocket(`${proto}//${location.host}${base}/ws`)
      ws.onopen = () => {
        while (queue.length) ws.send(JSON.stringify(queue.shift()))
        post({ type: "ready" })
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
    recording: false,
    busy: false,
    needsConfirm: false,
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
        $("mic").classList.toggle("busy", state.busy && !state.recording)
        if (msg.phase === "idle") setStatus("ok", msg.text || "Ready")
        else if (msg.phase === "confirm") setStatus("busy", msg.text || "Confirm?")
        else setStatus("busy", msg.text || msg.phase)
        break
      case "transcript":
        showTranscript(msg.text, false)
        break
      case "actions":
        showActions(msg.items || [], msg.needsConfirm, msg.say)
        break
      case "results":
        showResults(msg.items || [])
        break
      case "error":
        showError(msg.message)
        break
      case "record":
        if (msg.start && !state.recording) startRecording()
        else if (!msg.start && state.recording) stopRecording()
        break
    }
  }

  function applyState(s) {
    state.sttMode = s.sttMode
    state.language = s.language || ""
    state.speakReplies = s.speakReplies !== false
    const setup = s.setup || {}
    const card = $("setup")
    card.classList.toggle("hidden", Boolean(setup.complete && setup.claudeLogin))
    $("stepAnthropic").classList.toggle("done", Boolean(setup.anthropic))
    $("stepClaude").classList.toggle("done", Boolean(setup.claudeLogin))
    $("stepSpeech").classList.toggle("done", Boolean(setup.speechKey))
    const desc = { browser: "browser built-in (free)", openai: "OpenAI gpt-4o-transcribe", deepgram: "Deepgram Nova-3" }
    $("speechDesc").textContent = desc[s.provider] || s.provider
    $("btnSpeechKey").classList.toggle("hidden", s.provider === "browser")
    $("modelInfo").textContent = `${s.model} · ${s.provider}`
    renderTerminals(s.terminals || [])
    if (!setup.anthropic) setStatus("", "Needs setup")
    else if (!state.recording && !state.busy) setStatus("ok", "Ready")
    $("btnSpeak").classList.toggle("off", !speakEnabled)
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

  function showTranscript(text, interim) {
    const el = $("transcript")
    el.textContent = text || "…"
    el.classList.toggle("interim", Boolean(interim))
    el.classList.toggle("muted", !text)
  }

  function showActions(items, needsConfirm, say) {
    const card = $("actionsCard")
    const ul = $("actions")
    ul.innerHTML = ""
    for (const it of items) {
      const li = document.createElement("li")
      li.textContent = it.label
      if (it.dangerous) li.classList.add("dangerous")
      ul.appendChild(li)
    }
    state.needsConfirm = Boolean(needsConfirm)
    $("confirmRow").classList.toggle("hidden", !needsConfirm)
    const reply = $("reply")
    reply.textContent = say || ""
    reply.classList.toggle("hidden", !say)
    card.classList.toggle("hidden", !items.length && !say)
    if (say) speak(say)
    if (needsConfirm) speak("This looks destructive. Say yes to confirm.")
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
    showError.t = setTimeout(() => el.classList.add("hidden"), 8000)
  }

  function speak(text) {
    if (!speakEnabled || !state.speakReplies || !("speechSynthesis" in window)) return
    try {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      if (state.language) u.lang = state.language
      u.rate = 1.05
      window.speechSynthesis.speak(u)
    } catch (e) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ recording
  let recognition = null
  let recorder = null
  let chunks = []
  let stream = null
  let maxTimer = null

  function setRecording(active) {
    state.recording = active
    $("mic").classList.toggle("recording", active)
    $("mic").classList.remove("busy")
    setStatus(active ? "recording" : "ok", active ? "Listening… tap to send" : "Ready")
    post({ type: "recording", active })
  }

  async function startRecording() {
    $("micError").classList.add("hidden")
    if (state.sttMode === "browser") return startBrowserRecognition()
    return startMediaRecorder()
  }

  function stopRecording() {
    if (recognition) {
      try {
        recognition.stop()
      } catch (e) {
        /* ignore */
      }
      return
    }
    if (recorder && recorder.state !== "inactive") recorder.stop()
  }

  function micFailure(err) {
    const name = err && err.name
    let msg = "Microphone unavailable: " + (err && err.message ? err.message : name || err)
    if (name === "NotAllowedError" || name === "SecurityError" || /permission|denied|not allowed/i.test(msg)) {
      msg =
        mode === "webview"
          ? 'Microphone is blocked inside this panel. Allow it in the browser\'s site settings, or use "Open in a browser tab" below.'
          : "Microphone permission denied. Allow it in your browser's site settings and reload."
    } else if (name === "NotFoundError") {
      msg = "No microphone found."
    }
    showError(msg)
    setRecording(false)
    post({ type: "log", text: `mic failure: ${name} ${err && err.message}` })
  }

  function startBrowserRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      showError(
        "This browser has no built-in speech recognition. Use Chrome/Edge/Safari, or switch the speech engine to OpenAI or Deepgram in settings.",
      )
      return
    }
    recognition = new SR()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    if (state.language) recognition.lang = state.language
    let finalText = ""
    recognition.onresult = (e) => {
      let interim = ""
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += r[0].transcript
        else interim += r[0].transcript
      }
      showTranscript(finalText + interim, true)
    }
    recognition.onerror = (e) => {
      recognition = null
      if (e.error === "no-speech") {
        setRecording(false)
        setStatus("ok", "Didn't hear anything")
        return
      }
      if (e.error === "aborted") {
        setRecording(false)
        return
      }
      micFailure({ name: e.error === "not-allowed" ? "NotAllowedError" : e.error, message: e.message || e.error })
    }
    recognition.onend = () => {
      recognition = null
      setRecording(false)
      const text = finalText.trim()
      if (text) post({ type: "transcript", text })
    }
    try {
      recognition.start()
      showTranscript("", false)
      setRecording(true)
    } catch (err) {
      recognition = null
      micFailure(err)
    }
  }

  async function startMediaRecorder() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('Audio recording is not available in this browser context. Use "Open in a browser tab".')
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (err) {
      micFailure(err)
      return
    }
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find(
      (m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m),
    )
    chunks = []
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined)
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      micFailure(err)
      return
    }
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data)
    }
    recorder.onstop = async () => {
      clearTimeout(maxTimer)
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" })
      recorder = null
      setRecording(false)
      if (blob.size < 1000) {
        setStatus("ok", "Too short")
        return
      }
      setStatus("busy", "Uploading…")
      const data = await blobToBase64(blob)
      post({ type: "audio", mime: blob.type, data })
    }
    recorder.start(250)
    showTranscript("", false)
    setRecording(true)
    maxTimer = setTimeout(() => recorder && recorder.state !== "inactive" && recorder.stop(), 60000)
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
    if (state.recording) stopRecording()
    else startRecording()
  })
  $("btnConfirm").addEventListener("click", () => post({ type: "confirm", accept: true }))
  $("btnCancel").addEventListener("click", () => post({ type: "confirm", accept: false }))
  $("btnRemote").addEventListener("click", (e) => {
    e.preventDefault()
    post({ type: "openRemote" })
  })
  $("btnSettings").addEventListener("click", () => post({ type: "openSettings" }))
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
    post({ type: "text", text })
  })
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault()
      state.recording ? stopRecording() : startRecording()
    }
  })

  if (mode === "webview") post({ type: "ready" })
})()
