"""Generate a new, original image inspired by the look of a trending post's image.

Flow:
  1. Download the reference image.
  2. Claude (vision) turns the reference image + the owner's remake instruction into a
     detailed English prompt for the image model. The image model is given only this text, not
     the reference image, so this step is what "inherits" the reference: only its non-copyrightable qualities (mood,
     palette, lighting, framing, camera style, kind of scene). The prompt is told NOT to
     reproduce the specific subject, people, brands, logos or text of the original.
  3. OpenAI's image model renders the prompt; the PNG is saved locally and its path is returned.

Notes:
  * DALL-E 3 was removed from the OpenAI API (2026), so this uses the current gpt-image
    models. They return base64 data, not a URL, hence the saved file. Threads needs a public
    image URL, so host the file (e.g. commit it to the public GitHub repo) before posting.
  * The model id can be changed with OPENAI_IMAGE_MODEL.
  * Use the result for atmosphere / background / graphics. Do NOT present a generated
    picture as a photo of the actual product being advertised: it would misrepresent the
    product (misleading-representation rules in the Act against Unjustifiable Premiums
    and Misleading Representations).
  * The reference image belongs to its author. Only its general look is used, never its
    expression; do not paste copies of the original into the instruction either.

Environment (.env, never committed):
  OPENAI_API_KEY      OpenAI image generation
  OPENAI_IMAGE_MODEL  optional, default gpt-image-2.5-flare
  ANTHROPIC_API_KEY   Claude vision (already used by the TypeScript side of this repo)
"""

from __future__ import annotations

import base64
import os
from datetime import datetime
from pathlib import Path

import anthropic
import requests
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

CLAUDE_MODEL = "claude-opus-5"
DEFAULT_IMAGE_MODEL = "gpt-image-2.5-flare"
OUTPUT_DIR = Path("generated_images")
PROMPT_MAX_CHARS = 3800
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # Anthropic's per-image limit.
SUPPORTED_MEDIA_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

PROMPT_WRITER_SYSTEM = """You write image-generation prompts for OpenAI's GPT Image model.

You are given a reference image (a trending social media post's photo) and a remake instruction.
Write ONE detailed English prompt that produces a NEW, original image which keeps the reference's
general look, and applies the remake instruction.

Keep (describe them concretely): overall mood, colour palette, lighting, time of day, depth of field,
camera angle and framing, photographic or illustration style, type of scene (e.g. casual smartphone
snapshot, moody indoor still life), and composition category (e.g. close-up of a hand holding an object
on the left third, two-shot layout).

Do NOT reproduce: the exact subject or arrangement, any real person's face or likeness, brand names,
product packaging, logos, watermarks, usernames, or any text visible in the reference. Invent a fresh,
generic subject with the same feel. If the remake instruction asks for text in the image, write the
exact text to render in quotation marks; otherwise state that the image contains no text.

Output ONLY the prompt (no preface, no markdown), under 3500 characters."""


def _load_reference_image(url: str) -> tuple[str, str]:
    """Download the reference image and return (media_type, base64_data)."""
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    media_type = response.headers.get("Content-Type", "").split(";")[0].strip().lower()
    if media_type not in SUPPORTED_MEDIA_TYPES:
        raise ValueError(f"Unsupported image type {media_type!r} for {url}")
    if len(response.content) > MAX_IMAGE_BYTES:
        raise ValueError(f"Reference image is larger than {MAX_IMAGE_BYTES} bytes: {url}")
    return media_type, base64.standard_b64encode(response.content).decode("ascii")


def _write_image_prompt(original_image_url: str, remake_instruction: str) -> str:
    media_type, image_data = _load_reference_image(original_image_url)
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    message = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=1500,
        system=PROMPT_WRITER_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": media_type, "data": image_data},
                    },
                    {"type": "text", "text": f"Remake instruction: {remake_instruction}"},
                ],
            }
        ],
    )
    prompt = "".join(block.text for block in message.content if block.type == "text").strip()
    if not prompt:
        raise RuntimeError("Claude returned an empty prompt.")
    return prompt[:PROMPT_MAX_CHARS]


def remake_image_with_ai(original_image_url: str, remake_instruction: str) -> str:
    """Generate a new image inspired by the look of ``original_image_url`` and return its file path.

    Args:
        original_image_url: URL of the trending post's image (used only as a look reference).
        remake_instruction: How to change it, e.g. "make it cyberpunk" or "add centered text 'Skincare'".

    Returns:
        Path (as a string) of the generated PNG under ./generated_images/.
        (OpenAI's current image models return base64 data, not a URL.)
    """
    for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        if not os.environ.get(name):
            raise RuntimeError(f"{name} is not set. Add it to your .env file.")

    image_prompt = _write_image_prompt(original_image_url, remake_instruction)

    # openai>=1.0 replaced the old `openai.Image.create(...)` with the client below.
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    result = client.images.generate(
        model=os.environ.get("OPENAI_IMAGE_MODEL", DEFAULT_IMAGE_MODEL),
        prompt=image_prompt,
        size="1024x1024",
        n=1,
    )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"remake_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
    path.write_bytes(base64.b64decode(result.data[0].b64_json))
    return str(path)


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 3:
        raise SystemExit('Usage: python remake_image.py "<original_image_url>" "<remake_instruction>"')
    print(remake_image_with_ai(sys.argv[1], sys.argv[2]))
