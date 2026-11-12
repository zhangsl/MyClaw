import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="base")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--language")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="myclaw-asr-") as directory:
        wav = Path(directory) / "audio.wav"
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", args.audio, "-ac", "1", "-ar", "16000", str(wav)],
            check=True, capture_output=True, timeout=60,
        )
        cached = Path(args.model_dir) / f"models--Systran--faster-whisper-{args.model}" / "refs" / "main"
        local_only = Path(args.model).is_dir() or cached.is_file()
        model = WhisperModel(
            args.model, device="cpu", compute_type="int8", download_root=args.model_dir,
            local_files_only=local_only, cpu_threads=2, num_workers=1,
        )
        segments, _ = model.transcribe(
            str(wav), beam_size=5, language=args.language, vad_filter=True,
            condition_on_previous_text=False,
        )
        text = "".join(segment.text for segment in segments).strip()
        print(json.dumps({"text": text}, ensure_ascii=False))


if __name__ == "__main__":
    main()
