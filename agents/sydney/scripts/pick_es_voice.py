"""A/B test Cartesia Spanish voice candidates for Sydney.

You browse https://play.cartesia.ai/voices, find 2-3 candidates that
match the brand criteria below, drop their voice IDs into the
CANDIDATES list, and run this script. It synthesizes the same short
script in each voice via LiveKit Inference (no separate Cartesia key
needed) and writes them to /tmp/sydney_es_*.wav so you can play them
back and pick the one that sounds right.

Brand criteria for the Sydney ES voice:
  - LATIN AMERICAN Spanish (NOT Castilian/Spain — FL homeowners hear
    Castilian as foreign / formal)
  - Warm, conversational, not corporate / not radio-broadcast
  - Female (matches the English "Southern Woman" voice — keep brand
    voice consistent across languages)
  - Mid-range pitch (clear on phone audio bandwidth, ~300-3400 Hz)
  - "Caribbean-friendly" if available — FL Spanish is heavily
    Caribbean-influenced (Cuban, Puerto Rican, Dominican). Mexican
    Spanish is the next-best fit. Argentinian / Chilean would sound
    too distant.

Cartesia filters to apply on play.cartesia.ai/voices:
  - Language: Spanish
  - Region: Latin American (or specifically Mexico / Caribbean)
  - Gender: Female
  - Use case: Conversational / Customer Service (NOT Narration)

Run:
    cd agents/sydney
    source .venv/bin/activate
    # Edit CANDIDATES below with 2-3 voice IDs from Cartesia, then:
    python scripts/pick_es_voice.py

    # Plays back via macOS afplay; on other OSes open the .wav files
    # in your audio player of choice.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# ─── DROP CANDIDATE VOICE IDS HERE ────────────────────────────────────
# Browse play.cartesia.ai/voices, copy 2-3 voice IDs that match the
# brand criteria above. Voice IDs look like UUIDs.
#
# Example (these are PLACEHOLDERS — replace with real IDs you picked):
CANDIDATES: list[tuple[str, str]] = [
    # ("description for your own reference", "voice_id_uuid"),
    # ("Warm Caribbean-flavored", "00000000-0000-0000-0000-000000000000"),
    # ("Mexican mid-pitch female", "11111111-1111-1111-1111-111111111111"),
    # ("Universal LatAm professional", "22222222-2222-2222-2222-222222222222"),
]

# ─── Test script — what the voice will speak ──────────────────────────
# Two sentences. First is the opener (verbatim from build_outbound_opener
# Spanish branch) — exact production phrasing so you hear it in context.
# Second is a follow-up sentence with numbers + a question, which
# stress-tests pronunciation of common things like prices + dates.
SCRIPT = (
    "Hola María, soy Sydney, asistente de voz AI de Noland's Roofing. "
    "Gracias por haber probado nuestro estimador de techo hace unos "
    "minutos. ¿Tienes un par de minutos ahora para coordinar un "
    "horario que te funcione? "
    "Tenemos disponibilidad el martes diecisiete de marzo a las diez "
    "de la mañana, o el jueves a las dos de la tarde."
)


async def synthesize(voice_id: str, label: str, out_path: Path) -> None:
    """Synthesize SCRIPT with the given Cartesia voice via LK Inference."""
    # Late import — keeps the script importable on machines without LK
    # SDK installed (e.g. CI lint).
    from livekit.agents import inference

    tts = inference.TTS(
        model="cartesia/sonic-3",
        voice=voice_id,
        extra_kwargs={"speed": 0.95},
    )

    print(f"\n[{label}] synthesizing {len(SCRIPT)} chars → {out_path}")

    # Capture frames from the streaming TTS response. The LK inference
    # TTS returns audio frames; we concatenate raw PCM and write a WAV
    # header at the end so any media player can open it.
    import wave
    import io

    audio_buffer = io.BytesIO()
    sample_rate = None
    num_channels = None

    async with tts.synthesize(SCRIPT) as stream:
        async for event in stream:
            frame = getattr(event, "frame", None) or event
            data = getattr(frame, "data", None)
            if data is None:
                continue
            audio_buffer.write(bytes(data))
            if sample_rate is None:
                sample_rate = getattr(frame, "sample_rate", 24000)
                num_channels = getattr(frame, "num_channels", 1)

    pcm = audio_buffer.getvalue()
    if not pcm:
        print(f"  ! no audio returned for {voice_id}")
        return

    with wave.open(str(out_path), "wb") as wav:
        wav.setnchannels(num_channels or 1)
        wav.setsampwidth(2)  # 16-bit PCM
        wav.setframerate(sample_rate or 24000)
        wav.writeframes(pcm)

    print(f"  ✓ wrote {len(pcm)} bytes → {out_path}")


async def main() -> None:
    if not CANDIDATES:
        print(__doc__)
        print(
            "\nNo CANDIDATES defined. Edit this script and add 2-3 voice "
            "IDs from play.cartesia.ai/voices, then re-run."
        )
        sys.exit(1)

    if not os.environ.get("LIVEKIT_URL") or not os.environ.get("LIVEKIT_API_KEY"):
        print(
            "ERROR: LIVEKIT_URL + LIVEKIT_API_KEY + LIVEKIT_API_SECRET "
            "must be set. Pull from Vercel:\n"
            "  cd ../.. && vercel env pull .env.local && cp .env.local agents/sydney/.env"
        )
        sys.exit(1)

    out_dir = Path("/tmp")
    out_files: list[Path] = []

    for label, voice_id in CANDIDATES:
        # Sanitize label for filename
        safe = "".join(c for c in label if c.isalnum() or c in "_-")[:32]
        out = out_dir / f"sydney_es_{safe}.wav"
        try:
            await synthesize(voice_id, label, out)
            out_files.append(out)
        except Exception as e:
            print(f"  ! {label} ({voice_id}) FAILED: {e}")

    if not out_files:
        print("\nNo files written. Check the errors above.")
        sys.exit(1)

    print(f"\n✓ {len(out_files)} sample(s) written. Playback:")
    for f in out_files:
        print(f"    afplay {f}")
    print(
        "\nPick the one that sounds right, then set:\n"
        "    export SYDNEY_TTS_VOICE_ID_ES=<voice_id>\n"
        "    # and in Vercel:\n"
        "    vercel env add SYDNEY_TTS_VOICE_ID_ES production --no-sensitive\n"
        "    # and in LK Cloud Agent secrets if you've deployed Sydney to LK Cloud."
    )

    # On macOS, auto-play the first one as a convenience.
    if sys.platform == "darwin" and out_files:
        print(f"\nAuto-playing {out_files[0]}...")
        subprocess.run(["afplay", str(out_files[0])], check=False)


if __name__ == "__main__":
    asyncio.run(main())
