# Built-in speech-to-text (server engine)

`whisper_worker.py` is started by the Voice Control extension when the speech
engine is `server` (the default when this is installed). It runs
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) on the CPU with an
int8 model and keeps it loaded between requests. Audio recorded in the browser
is sent to the server and never leaves it.

- Model: `DIGITAL_TWIN_STT_MODEL` (`tiny`, `base` (default), `small`, `medium`;
  larger is more accurate and slower). Models are pre-downloaded into the image
  under `/opt/digital-twin/models`; a different model downloads on first use
  into the same cache (needs network).
- Threads: `DIGITAL_TWIN_STT_THREADS` (default: up to 4).
- Interpreter: the image's `/opt/digital-twin/stt/venv/bin/python`; override with
  `DIGITAL_TWIN_STT_PYTHON` (a repo checkout can point it at any venv that has
  faster-whisper installed).
- Disable: set `DIGITAL_TWIN_STT=off` to skip installing it; the extension then
  falls back to the browser engine.
