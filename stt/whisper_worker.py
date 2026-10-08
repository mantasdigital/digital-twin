#!/usr/bin/env python3
"""Built-in speech-to-text for Digital Twin Voice Control.

A long-lived worker: the extension starts it once, then sends one JSON
object per line on stdin and reads one JSON object per line on stdout.
Audio never leaves the server. Uses faster-whisper (CTranslate2, CPU, int8);
PyAV decodes whatever the browser recorded (webm/opus, mp4, ogg, wav).

  request : {"id": "...", "file": "/path/clip.webm", "language": "en" | "",
             "prompt": "vocabulary hints ...", "delete": true}
  response: {"id": "...", "text": "...", "language": "en", "ms": 1234}
            {"id": "...", "error": "..."}
  startup : {"ready": true, "model": "base", "load_ms": 900}
"""
import json
import os
import sys
import time

MODEL = os.environ.get("DIGITAL_TWIN_STT_MODEL", "base")
THREADS = int(os.environ.get("DIGITAL_TWIN_STT_THREADS", "0")) or max(1, min(4, os.cpu_count() or 1))


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def decode(path, rate=16000):
    """Decode anything PyAV understands to mono float32 at `rate`.

    Written against the stable PyAV API only (faster-whisper's own helper
    passes a keyword that newer PyAV versions removed).
    """
    import av
    import numpy as np

    frames = []
    with av.open(path) as container:
        stream = next(s for s in container.streams if s.type == "audio")
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=rate)
        for frame in container.decode(stream):
            for f in resampler.resample(frame):
                frames.append(f.to_ndarray().reshape(-1))
        for f in resampler.resample(None):
            frames.append(f.to_ndarray().reshape(-1))
    audio = np.concatenate(frames).astype(np.float32) if frames else np.zeros(0, dtype=np.float32)
    # Quiet or whispered speech: bring the peak up so the log-mel front end sees
    # a normal level. (Whisper is fairly level-robust already; this removes the
    # remaining gap for very soft input and costs nothing.)
    peak = float(np.abs(audio).max()) if audio.size else 0.0
    if 0.0 < peak < 0.5:
        audio = audio * (0.9 / peak)
    return audio


def main():
    t0 = time.time()
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
    except Exception as exc:  # missing package, missing model, ...
        emit({"ready": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1
    emit({"ready": True, "model": MODEL, "load_ms": int((time.time() - t0) * 1000)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            emit({"error": "bad request"})
            continue
        rid = req.get("id")
        path = req.get("file")
        t = time.time()
        try:
            language = (req.get("language") or "").split("-")[0].lower() or None
            # Vocabulary goes in as hotwords (bias), not as the prompt: with a
            # short prompt greedy decoding tended to stop after one word.
            hotwords = " ".join((req.get("prompt") or "").replace(",", " ").split())[:300] or None
            audio = decode(path)
            seconds = audio.shape[0] / 16000.0
            if seconds < 0.3:
                emit({"id": rid, "text": "", "language": language or "", "ms": int((time.time() - t) * 1000), "seconds": round(seconds, 2)})
                continue
            segments, info = model.transcribe(
                audio,
                language=language,
                initial_prompt="Developer dictation in VS Code.",
                hotwords=hotwords,
                beam_size=5,
                best_of=5,
                # Clips are already delimited by the user (tap/pause); the VAD
                # filter would only risk cutting soft speech. Keep it for long clips.
                vad_filter=seconds > 20,
                vad_parameters={"min_silence_duration_ms": 400, "threshold": 0.35},
                condition_on_previous_text=False,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
            emit({"id": rid, "text": text, "language": info.language, "ms": int((time.time() - t) * 1000), "seconds": round(seconds, 2)})
        except Exception as exc:
            emit({"id": rid, "error": f"{type(exc).__name__}: {exc}"})
        finally:
            if req.get("delete") and path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
